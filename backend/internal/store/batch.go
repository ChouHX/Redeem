package store

import (
	"database/sql"
	"errors"
	"strings"

	"github.com/redeem/backend/internal/domain"
)

// sqlChunkSize 与 Node 的 SQL_CHUNK_SIZE 一致：
// SQLite 单条语句的变量上限是 999，400 留足余量给额外参数。
const sqlChunkSize = 400

func chunkIDs(ids []int64, size int) [][]int64 {
	chunks := make([][]int64, 0, (len(ids)+size-1)/size)
	for start := 0; start < len(ids); start += size {
		end := start + size
		if end > len(ids) {
			end = len(ids)
		}
		chunks = append(chunks, ids[start:end])
	}
	return chunks
}

// UpdateInventoryBatch 批量改库存的状态或归属类型。
// 与 updateRedeemInventoryBatch 一致：换类型时按目标 schema 重算 serialized_value，
// 重算后与其它行重复的跳过，已兑换的跳过。
func (s *Store) UpdateInventoryBatch(ids []int64, typeID int64, status string) (map[string]any, error) {
	nextStatus := ""
	if status == "available" || status == "unavailable" {
		nextStatus = status
	}
	nextTypeID := int64(0)
	if typeID > 0 {
		nextTypeID = typeID
	}
	if nextStatus == "" && nextTypeID == 0 {
		return nil, errors.New("请至少指定一个库存修改项")
	}

	var targetType *RedeemTypeView
	if nextTypeID > 0 {
		found, err := s.RedeemTypeByID(nextTypeID)
		if err != nil {
			return nil, err
		}
		if found == nil {
			return nil, errors.New("兑换类型不存在")
		}
		targetType = found
	}

	updated := 0
	skipped := 0

	err := s.inTx(func(tx *sql.Tx) error {
		// 只改状态：一条分块 UPDATE 就够，不需要逐行读改写。
		if targetType == nil {
			for _, chunk := range chunkIDs(ids, sqlChunkSize) {
				placeholders, args := placeholdersFor(chunk)
				statement := `
					UPDATE redeem_inventory
					SET status = ?, updated_at = CURRENT_TIMESTAMP
					WHERE id IN (` + placeholders + `)
					  AND status <> 'redeemed'
					  AND status <> ?
				`
				allArgs := append([]any{nextStatus}, args...)
				allArgs = append(allArgs, nextStatus)
				result, err := tx.Exec(statement, allArgs...)
				if err != nil {
					return err
				}
				changes, _ := result.RowsAffected()
				updated += int(changes)
			}
			skipped = len(ids) - updated
			return nil
		}

		updateStmt, err := tx.Prepare(`
			UPDATE redeem_inventory
			SET type_id = ?, serialized_value = ?, status = ?, updated_at = CURRENT_TIMESTAMP
			WHERE id = ?
		`)
		if err != nil {
			return err
		}
		defer updateStmt.Close()

		duplicateStmt, err := tx.Prepare(`
			SELECT id FROM redeem_inventory
			WHERE type_id = ? AND serialized_value = ? AND id <> ?
			LIMIT 1
		`)
		if err != nil {
			return err
		}
		defer duplicateStmt.Close()

		for _, chunk := range chunkIDs(ids, sqlChunkSize) {
			placeholders, args := placeholdersFor(chunk)
			rows, err := tx.Query(`
				SELECT
					inventory.id,
					inventory.type_id,
					inventory.serialized_value,
					inventory.status,
					types.field_schema,
					types.import_delimiter
				FROM redeem_inventory inventory
				JOIN redeem_email_types types ON types.id = inventory.type_id
				WHERE inventory.id IN (`+placeholders+`)
			`, args...)
			if err != nil {
				return err
			}

			type rowState struct {
				typeID        int64
				serialized    string
				status        string
				fieldSchema   string
				delimiter     string
			}
			byID := map[int64]rowState{}
			for rows.Next() {
				var (
					id           int64
					rowTypeID    int64
					serialized   string
					rowStatus    string
					fieldSchema  string
					delimiter    sql.NullString
				)
				if err := rows.Scan(&id, &rowTypeID, &serialized, &rowStatus, &fieldSchema, &delimiter); err != nil {
					rows.Close()
					return err
				}
				byID[id] = rowState{
					typeID:      rowTypeID,
					serialized:  serialized,
					status:      rowStatus,
					fieldSchema: fieldSchema,
					delimiter:   NullString(delimiter),
				}
			}
			if err := rows.Err(); err != nil {
				rows.Close()
				return err
			}
			rows.Close()

			for _, id := range chunk {
				row, exists := byID[id]
				if !exists || row.status == "redeemed" {
					skipped++
					continue
				}

				finalFieldSchema := domain.ParseFieldSchema(row.fieldSchema)
				if targetType != nil {
					finalFieldSchema = targetType.FieldSchema
				}
				finalDelimiter := row.delimiter
				if finalDelimiter == "" {
					finalDelimiter = "----"
				}
				if targetType != nil {
					finalDelimiter = targetType.ImportDelimiter
				}

				finalTypeID := row.typeID
				if targetType != nil {
					finalTypeID = targetType.ID
				}

				finalSerialized := domain.SerializeInventoryPayload(
					finalFieldSchema,
					domain.RawLinePayload(row.serialized),
					finalDelimiter,
				)
				finalStatus := row.status
				if nextStatus != "" {
					finalStatus = nextStatus
				}

				if finalTypeID == row.typeID &&
					finalSerialized == row.serialized &&
					finalStatus == row.status {
					skipped++
					continue
				}

				if finalSerialized != row.serialized {
					var duplicateID int64
					err := duplicateStmt.QueryRow(finalTypeID, finalSerialized, id).Scan(&duplicateID)
					if err == nil {
						skipped++
						continue
					}
					if !errors.Is(err, sql.ErrNoRows) {
						return err
					}
				}

				result, err := updateStmt.Exec(finalTypeID, finalSerialized, finalStatus, id)
				if err != nil {
					return err
				}
				changes, _ := result.RowsAffected()
				updated += int(changes)
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	output := map[string]any{
		"updated_count": updated,
		"skipped_count": skipped,
		"total_count":   len(ids),
		"status":        nil,
		"type_id":       nil,
	}
	if nextStatus != "" {
		output["status"] = nextStatus
	}
	if targetType != nil {
		output["type_id"] = targetType.ID
	}
	return output, nil
}

// UpdateCodeStatusBatch 批量启用/禁用卡密，已兑换的不动。
func (s *Store) UpdateCodeStatusBatch(ids []int64, status string) (map[string]any, error) {
	nextStatus := "unused"
	if status == "disabled" {
		nextStatus = "disabled"
	}

	updated := 0
	err := s.inTx(func(tx *sql.Tx) error {
		for _, chunk := range chunkIDs(ids, sqlChunkSize) {
			placeholders, args := placeholdersFor(chunk)
			statement := `
				UPDATE redeem_codes
				SET status = ?, updated_at = CURRENT_TIMESTAMP
				WHERE id IN (` + placeholders + `)
				  AND status <> 'redeemed'
				  AND status <> ?
			`
			allArgs := append([]any{nextStatus}, args...)
			allArgs = append(allArgs, nextStatus)
			result, err := tx.Exec(statement, allArgs...)
			if err != nil {
				return err
			}
			changes, _ := result.RowsAffected()
			updated += int(changes)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	return map[string]any{
		"updated_count": updated,
		"skipped_count": len(ids) - updated,
		"total_count":   len(ids),
		"status":        nextStatus,
	}, nil
}

// UpdateCodeBatch 批量改卡密的类型或可兑数量，已兑换的跳过。
func (s *Store) UpdateCodeBatch(ids []int64, typeID int64, quantity int) (map[string]any, error) {
	nextTypeID := int64(0)
	if typeID > 0 {
		nextTypeID = typeID
	}
	nextQuantity := 0
	if quantity > 0 {
		nextQuantity = quantity
	}
	if nextTypeID == 0 && nextQuantity == 0 {
		return nil, errors.New("请至少指定一个卡密修改项")
	}

	var targetType *RedeemTypeView
	if nextTypeID > 0 {
		found, err := s.RedeemTypeByID(nextTypeID)
		if err != nil {
			return nil, err
		}
		if found == nil {
			return nil, errors.New("兑换类型不存在")
		}
		targetType = found
	}

	updated := 0
	skipped := 0

	err := s.inTx(func(tx *sql.Tx) error {
		updateStmt, err := tx.Prepare(`
			UPDATE redeem_codes
			SET type_id = ?, quantity = ?, updated_at = CURRENT_TIMESTAMP
			WHERE id = ?
		`)
		if err != nil {
			return err
		}
		defer updateStmt.Close()

		for _, chunk := range chunkIDs(ids, sqlChunkSize) {
			placeholders, args := placeholdersFor(chunk)
			rows, err := tx.Query(
				"SELECT id, type_id, quantity, status FROM redeem_codes WHERE id IN ("+placeholders+")",
				args...)
			if err != nil {
				return err
			}

			type rowState struct {
				typeID   int64
				quantity int
				status   string
			}
			byID := map[int64]rowState{}
			for rows.Next() {
				var (
					id          int64
					rowType     int64
					rowQty      int
					rowStatus   string
				)
				if err := rows.Scan(&id, &rowType, &rowQty, &rowStatus); err != nil {
					rows.Close()
					return err
				}
				byID[id] = rowState{typeID: rowType, quantity: rowQty, status: rowStatus}
			}
			if err := rows.Err(); err != nil {
				rows.Close()
				return err
			}
			rows.Close()

			for _, id := range chunk {
				row, exists := byID[id]
				if !exists || row.status == "redeemed" {
					skipped++
					continue
				}

				finalTypeID := row.typeID
				if targetType != nil {
					finalTypeID = targetType.ID
				}
				finalQuantity := row.quantity
				if finalQuantity < 1 {
					finalQuantity = 1
				}
				if nextQuantity > 0 {
					finalQuantity = nextQuantity
				}

				if finalTypeID == row.typeID && finalQuantity == row.quantity {
					skipped++
					continue
				}

				result, err := updateStmt.Exec(finalTypeID, finalQuantity, id)
				if err != nil {
					return err
				}
				changes, _ := result.RowsAffected()
				updated += int(changes)
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	output := map[string]any{
		"updated_count": updated,
		"skipped_count": skipped,
		"total_count":   len(ids),
		"type_id":       nil,
		"quantity":      nil,
	}
	if targetType != nil {
		output["type_id"] = targetType.ID
	}
	if nextQuantity > 0 {
		output["quantity"] = nextQuantity
	}
	return output, nil
}

// DeleteCodeBatchResult 是批量删除卡密的统计。
type DeleteCodeBatchResult struct {
	DeletedCount int `json:"deleted_count"`
	SkippedCount int `json:"skipped_count"`
	TotalCount   int `json:"total_count"`
}

// DeleteCodeBatch 批量删除卡密，已兑换的跳过（记录要留着对账）。
func (s *Store) DeleteCodeBatch(ids []int64) (DeleteCodeBatchResult, error) {
	output := DeleteCodeBatchResult{TotalCount: len(ids)}
	deletable := make([]int64, 0, len(ids))

	err := s.inTx(func(tx *sql.Tx) error {
		for _, chunk := range chunkIDs(ids, sqlChunkSize) {
			placeholders, args := placeholdersFor(chunk)
			rows, err := tx.Query(
				"SELECT id, status FROM redeem_codes WHERE id IN ("+placeholders+")", args...)
			if err != nil {
				return err
			}
			statusByID := map[int64]string{}
			for rows.Next() {
				var (
					id     int64
					status string
				)
				if err := rows.Scan(&id, &status); err != nil {
					rows.Close()
					return err
				}
				statusByID[id] = status
			}
			if err := rows.Err(); err != nil {
				rows.Close()
				return err
			}
			rows.Close()

			for _, id := range chunk {
				status, exists := statusByID[id]
				if !exists || status == "redeemed" {
					output.SkippedCount++
					continue
				}
				deletable = append(deletable, id)
			}
		}

		for _, chunk := range chunkIDs(deletable, sqlChunkSize) {
			placeholders, args := placeholdersFor(chunk)
			result, err := tx.Exec("DELETE FROM redeem_codes WHERE id IN ("+placeholders+")", args...)
			if err != nil {
				return err
			}
			changes, _ := result.RowsAffected()
			output.DeletedCount += int(changes)
		}
		return nil
	})
	if err != nil {
		return output, err
	}
	return output, nil
}

// CodesForExport 按筛选条件导出全部卡密（不分页）。
func (s *Store) CodesForExport(filter CodeFilter) ([]Code, error) {
	where, params := buildCodeWhere(filter)
	rows, err := s.db.Query(codeSelect+" "+where+" ORDER BY codes.id DESC", params...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanCodeRows(rows)
}

// inventoryExportLine 取一条库存的原始序列化文本，用于导出。
func (s *Store) inventoryExportLines(ids []int64) ([]string, error) {
	lines := make([]string, 0, len(ids))
	for _, chunk := range chunkIDs(ids, sqlChunkSize) {
		placeholders, args := placeholdersFor(chunk)
		rows, err := s.db.Query(
			"SELECT serialized_value FROM redeem_inventory WHERE id IN ("+placeholders+") ORDER BY id ASC",
			args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var value string
			if err := rows.Scan(&value); err != nil {
				rows.Close()
				return nil, err
			}
			lines = append(lines, strings.TrimSpace(value))
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
	}
	return lines, nil
}
