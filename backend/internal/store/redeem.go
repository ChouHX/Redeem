package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/redeem/backend/internal/domain"
)

// Inventory 是库存行视图，字段名与 rowToRedeemInventory 一致。
type Inventory struct {
	ID                int64          `json:"id"`
	TypeID            int64          `json:"type_id"`
	TypeName          string         `json:"type_name"`
	TypeSlug          string         `json:"type_slug"`
	FieldSchema       []domain.Field `json:"field_schema,omitempty"`
	MailProtocols     []string       `json:"mail_protocols"`
	MailProtocol      string         `json:"mail_protocol"`
	TypeMailProtocols []string       `json:"type_mail_protocols"`
	ImportDelimiter   string         `json:"import_delimiter"`
	Payload           domain.Payload `json:"payload"`
	SerializedValue   string         `json:"serialized_value"`
	SearchText        string         `json:"search_text"`
	Status            string         `json:"status"`
	RedeemedCodeID    *int64         `json:"redeemed_code_id"`
	RedeemedAt        *string        `json:"redeemed_at"`
	CreatedAt         string         `json:"created_at"`
	UpdatedAt         string         `json:"updated_at"`
}

// Code 是卡密视图，字段名与 rowToRedeemCode 一致。
type Code struct {
	ID                  int64   `json:"id"`
	Code                string  `json:"code"`
	NormalizedCode      string  `json:"normalized_code"`
	TypeID              int64   `json:"type_id"`
	TypeName            string  `json:"type_name"`
	TypeSlug            string  `json:"type_slug"`
	Quantity            int     `json:"quantity"`
	RedeemedQuantity    int     `json:"redeemed_quantity"`
	RemainingQuantity   int     `json:"remaining_quantity"`
	Note                string  `json:"note"`
	Status              string  `json:"status"`
	DerivedStatus       string  `json:"derived_status"`
	ExpiresAt           *string `json:"expires_at"`
	RedeemedInventoryID *int64  `json:"redeemed_inventory_id"`
	RedeemedAt          *string `json:"redeemed_at"`
	DataDeletedAt       *string `json:"data_deleted_at"`
	DataDeletedReason   string  `json:"data_deleted_reason"`
	CreatedAt           string  `json:"created_at"`
	UpdatedAt           string  `json:"updated_at"`
}

// Record 是兑换记录视图，字段名与 rowToRedeemRecord 一致。
type Record struct {
	ID                int64          `json:"id"`
	CodeID            int64          `json:"code_id"`
	InventoryID       int64          `json:"inventory_id"`
	TypeID            int64          `json:"type_id"`
	Code              string         `json:"code"`
	NormalizedCode    string         `json:"normalized_code"`
	TypeName          string         `json:"type_name"`
	TypeSlug          string         `json:"type_slug"`
	TypeDescription   string         `json:"type_description"`
	FieldSchema       []domain.Field `json:"field_schema,omitempty"`
	MailProtocols     []string       `json:"mail_protocols"`
	MailProtocol      string         `json:"mail_protocol"`
	TypeMailProtocols []string       `json:"type_mail_protocols"`
	ImportDelimiter   string         `json:"import_delimiter"`
	Payload           domain.Payload `json:"payload"`
	RequesterIP       string         `json:"requester_ip"`
	RequesterAgent    string         `json:"requester_user_agent"`
	RedeemedAt        string         `json:"redeemed_at"`
}

// RedeemResult 是兑换事务的返回值。
type RedeemResult struct {
	RecordID     *int64
	RecordIDs    []int64
	RedeemedCount int
	Code         Code
	Inventories  []Inventory
	Type         RedeemTypeView
}

// InventoryFilter 是库存列表筛选。
type InventoryFilter struct {
	TypeID   int64
	Status   string
	Protocol string
	Query    string
}

// buildInventoryWhere 与 buildRedeemInventoryWhere 同义。
// 三个字符以上走 FTS trigram，短词退回 LIKE 全表扫描。
func buildInventoryWhere(filter InventoryFilter) (string, []any) {
	conditions := make([]string, 0, 4)
	params := make([]any, 0, 4)

	if filter.TypeID > 0 {
		conditions = append(conditions, "inventory.type_id = ?")
		params = append(params, filter.TypeID)
	}
	switch filter.Status {
	case "available", "unavailable", "redeemed":
		conditions = append(conditions, "inventory.status = ?")
		params = append(params, filter.Status)
	}
	switch filter.Protocol {
	case "imap", "graph":
		conditions = append(conditions, "inventory.pickup_"+filter.Protocol+" = 1")
	}
	if query := strings.ToLower(strings.TrimSpace(filter.Query)); query != "" {
		if utf8.RuneCountInString(query) >= 3 {
			conditions = append(conditions,
				"inventory.id IN (SELECT rowid FROM redeem_inventory_fts WHERE search_text LIKE ?)")
		} else {
			conditions = append(conditions, "inventory.search_text LIKE ?")
		}
		params = append(params, "%"+query+"%")
	}

	if len(conditions) == 0 {
		return "", params
	}
	return "WHERE " + strings.Join(conditions, " AND "), params
}

const inventoryColumns = `
    inventory.id,
    inventory.type_id,
    inventory.serialized_value,
    inventory.search_text,
    inventory.status,
    inventory.pickup_protocols,
    inventory.redeemed_code_id,
    inventory.redeemed_at,
    inventory.created_at,
    inventory.updated_at`

const inventorySelect = `
  SELECT
    ` + inventoryColumns + `,
    types.name AS type_name,
    types.slug AS type_slug,
    types.field_schema,
    types.mail_protocol,
    types.mail_protocols AS type_mail_protocols,
    types.import_delimiter
  FROM redeem_inventory inventory
  JOIN redeem_email_types types ON types.id = inventory.type_id
`

// ListInventoryPaged 两段式分页：先取 id 再回表，避免深翻页排序整表。
func (s *Store) ListInventoryPaged(filter InventoryFilter, page, pageSize int) ([]Inventory, int, error) {
	where, params := buildInventoryWhere(filter)

	var total int
	if err := s.db.QueryRow(
		"SELECT COUNT(*) FROM redeem_inventory inventory "+where, params...,
	).Scan(&total); err != nil {
		return nil, 0, err
	}

	query := `
    SELECT
      ` + inventoryColumns + `,
      types.name AS type_name,
      types.slug AS type_slug,
      types.field_schema,
      types.mail_protocol,
      types.mail_protocols AS type_mail_protocols,
      types.import_delimiter
    FROM redeem_inventory inventory
    JOIN (
      SELECT id FROM redeem_inventory inventory
      ` + where + `
      ORDER BY inventory.id DESC
      LIMIT ? OFFSET ?
    ) page ON page.id = inventory.id
    JOIN redeem_email_types types ON types.id = inventory.type_id
    ORDER BY inventory.id DESC
  `
	args := append(append([]any{}, params...), pageSize, (page-1)*pageSize)
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	items, err := scanInventoryRows(rows)
	return items, total, err
}

// InventoryIDs 取筛选结果的全部 id（导出 / 批量操作前用）。
func (s *Store) InventoryIDs(filter InventoryFilter) ([]int64, error) {
	where, params := buildInventoryWhere(filter)
	rows, err := s.db.Query(
		"SELECT inventory.id FROM redeem_inventory inventory "+where+" ORDER BY inventory.id DESC",
		params...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// InventorySelectionCount 返回筛选结果条数。
func (s *Store) InventorySelectionCount(filter InventoryFilter) (int, error) {
	where, params := buildInventoryWhere(filter)
	var total int
	err := s.db.QueryRow(
		"SELECT COUNT(*) FROM redeem_inventory inventory "+where, params...).Scan(&total)
	return total, err
}

// InventoryByIDs 按 id 批量取库存，顺序与入参无关（按 id 升序）。
func (s *Store) InventoryByIDs(ids []int64) ([]Inventory, error) {
	if len(ids) == 0 {
		return []Inventory{}, nil
	}
	placeholders, args := placeholdersFor(ids)
	rows, err := s.db.Query(
		inventorySelect+" WHERE inventory.id IN ("+placeholders+") ORDER BY inventory.id ASC",
		args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanInventoryRows(rows)
}

// ImportInventory 导入库存；replace_available 模式先清空该类型的可售库存。
func (s *Store) ImportInventory(typeID int64, items []domain.ImportItem, mode string, mailProtocols []string) (map[string]any, error) {
	emailType, err := s.RedeemTypeByID(typeID)
	if err != nil {
		return nil, err
	}
	if emailType == nil {
		return nil, errors.New("兑换类型不存在")
	}

	normalizedMode := "append"
	if mode == "replace_available" {
		normalizedMode = "replace_available"
	}
	allowed := domain.NormalizeMailProtocols(emailType.MailProtocols, []string{emailType.MailProtocol})
	pickup := domain.NormalizeMailProtocols(mailProtocols, allowed)
	for _, protocol := range pickup {
		if !contains(allowed, protocol) {
			return nil, errors.New("导入协议不在该兑换类型允许的协议范围内")
		}
	}
	pickupJSON, err := json.Marshal(pickup)
	if err != nil {
		return nil, err
	}
	pickupIMAP, pickupGraph := protocolFlags(pickup)

	cleared, added, protocolsUpdated, skipped := 0, 0, 0, 0
	err = s.inTx(func(tx *sql.Tx) error {
		if normalizedMode == "replace_available" {
			result, err := tx.Exec(
				"DELETE FROM redeem_inventory WHERE type_id = ? AND status = 'available'", typeID)
			if err != nil {
				return err
			}
			changes, _ := result.RowsAffected()
			cleared = int(changes)
		}

		for _, item := range items {
			serialized := item.SerializedValue
			if serialized == "" {
				serialized = domain.SerializeInventoryPayload(
					emailType.FieldSchema, item.Payload, emailType.ImportDelimiter)
			}

			result, err := tx.Exec(`
				INSERT OR IGNORE INTO redeem_inventory (
					type_id, serialized_value, pickup_protocols, pickup_imap, pickup_graph,
					status, created_at, updated_at
				)
				VALUES (?, ?, ?, ?, ?, 'available', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
			`, typeID, serialized, string(pickupJSON), pickupIMAP, pickupGraph)
			if err != nil {
				return err
			}
			changes, _ := result.RowsAffected()
			if changes > 0 {
				added++
				continue
			}

			// 已存在同一行：把协议并集写回去，避免重复导入丢掉新协议。
			var existingID int64
			var existingProtocols string
			err = tx.QueryRow(
				"SELECT id, pickup_protocols FROM redeem_inventory WHERE type_id = ? AND serialized_value = ? LIMIT 1",
				typeID, serialized).Scan(&existingID, &existingProtocols)
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			if err == nil {
				before := domain.NormalizeMailProtocols(existingProtocols, nil)
				merged := domain.NormalizeMailProtocols(
					append(append([]string{}, before...), pickup...), pickup)
				if len(merged) != len(before) || !sameSet(merged, before) {
					mergedJSON, _ := json.Marshal(merged)
					imapFlag, graphFlag := protocolFlags(merged)
					updateResult, err := tx.Exec(`
						UPDATE redeem_inventory
						SET pickup_protocols = ?, pickup_imap = ?, pickup_graph = ?,
						    updated_at = CURRENT_TIMESTAMP
						WHERE id = ?
					`, string(mergedJSON), imapFlag, graphFlag, existingID)
					if err != nil {
						return err
					}
					updateChanges, _ := updateResult.RowsAffected()
					protocolsUpdated += int(updateChanges)
				}
			}
			skipped++
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	return map[string]any{
		"mode":                   normalizedMode,
		"cleared_count":          cleared,
		"added_count":            added,
		"protocols_updated_count": protocolsUpdated,
		"skipped_count":          skipped,
		"total_count":            len(items),
	}, nil
}

// UpdateInventoryStatus 只允许在 available / unavailable 之间切换。
func (s *Store) UpdateInventoryStatus(inventoryID int64, status string) (*Inventory, error) {
	nextStatus := "available"
	if status == "unavailable" {
		nextStatus = "unavailable"
	}

	rows, err := s.db.Query(inventorySelect+" WHERE inventory.id = ? LIMIT 1", inventoryID)
	if err != nil {
		return nil, err
	}
	items, err := scanInventoryRows(rows)
	rows.Close()
	if err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return nil, nil
	}

	current := items[0]
	if current.Status == "redeemed" {
		return nil, errors.New("已兑换的库存不能修改状态")
	}
	if current.Status != nextStatus {
		if _, err := s.db.Exec(
			"UPDATE redeem_inventory SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
			nextStatus, inventoryID); err != nil {
			return nil, err
		}
	}
	current.Status = nextStatus
	return &current, nil
}

// DeleteInventory 删除单条库存。
func (s *Store) DeleteInventory(inventoryID int64) (bool, error) {
	result, err := s.db.Exec("DELETE FROM redeem_inventory WHERE id = ?", inventoryID)
	if err != nil {
		return false, err
	}
	changes, _ := result.RowsAffected()
	return changes > 0, nil
}

// DeleteInventoryBatch 批量删除库存。
func (s *Store) DeleteInventoryBatch(ids []int64) (int64, error) {
	if len(ids) == 0 {
		return 0, nil
	}
	placeholders, args := placeholdersFor(ids)
	result, err := s.db.Exec("DELETE FROM redeem_inventory WHERE id IN ("+placeholders+")", args...)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

const codeColumns = `
    codes.id,
    codes.code,
    codes.normalized_code,
    codes.type_id,
    codes.quantity,
    codes.redeemed_quantity,
    codes.note,
    codes.status,
    codes.expires_at,
    codes.redeemed_inventory_id,
    codes.redeemed_at,
    codes.created_at,
    codes.updated_at,
    codes.data_deleted_at,
    codes.data_deleted_reason`

const codeSelect = `
  SELECT
    ` + codeColumns + `,
    types.name AS type_name,
    types.slug AS type_slug
  FROM redeem_codes codes
  JOIN redeem_email_types types ON types.id = codes.type_id
`

// CodeByNormalized 按规范化卡密查卡。
func (s *Store) CodeByNormalized(normalizedCode string) (*Code, error) {
	rows, err := s.db.Query(codeSelect+" WHERE codes.normalized_code = ? LIMIT 1", normalizedCode)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items, err := scanCodeRows(rows)
	if err != nil || len(items) == 0 {
		return nil, err
	}
	return &items[0], nil
}

// CodeByID 按 id 查卡。
func (s *Store) CodeByID(id int64) (*Code, error) {
	rows, err := s.db.Query(codeSelect+" WHERE codes.id = ? LIMIT 1", id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items, err := scanCodeRows(rows)
	if err != nil || len(items) == 0 {
		return nil, err
	}
	return &items[0], nil
}

// CodeFilter 是卡密列表筛选。
type CodeFilter struct {
	TypeID      int64
	Status      string
	Query       string
	MinQuantity int
	MaxQuantity int
}

func buildCodeWhere(filter CodeFilter) (string, []any) {
	conditions := make([]string, 0, 3)
	params := make([]any, 0, 3)

	if filter.TypeID > 0 {
		conditions = append(conditions, "codes.type_id = ?")
		params = append(params, filter.TypeID)
	}

	switch filter.Status {
	case "available":
		conditions = append(conditions,
			"codes.status = 'unused'",
			"(codes.expires_at IS NULL OR codes.expires_at > CURRENT_TIMESTAMP)")
	case "redeemed", "disabled", "unused":
		conditions = append(conditions, "codes.status = ?")
		params = append(params, filter.Status)
	case "expired":
		conditions = append(conditions,
			"codes.status = 'unused'",
			"codes.expires_at IS NOT NULL",
			"codes.expires_at <= CURRENT_TIMESTAMP")
	}

	if query := strings.TrimSpace(filter.Query); query != "" {
		conditions = append(conditions, "codes.normalized_code LIKE ?")
		params = append(params, "%"+domain.NormalizeRedeemCode(query)+"%")
	}

	if filter.MinQuantity > 0 {
		conditions = append(conditions, "codes.quantity >= ?")
		params = append(params, filter.MinQuantity)
	}
	if filter.MaxQuantity > 0 {
		conditions = append(conditions, "codes.quantity <= ?")
		params = append(params, filter.MaxQuantity)
	}

	if len(conditions) == 0 {
		return "", params
	}
	return "WHERE " + strings.Join(conditions, " AND "), params
}

// ListCodesPaged 卡密分页。
func (s *Store) ListCodesPaged(filter CodeFilter, page, pageSize int) ([]Code, int, error) {
	where, params := buildCodeWhere(filter)

	var total int
	if err := s.db.QueryRow(
		"SELECT COUNT(*) FROM redeem_codes codes "+where, params...).Scan(&total); err != nil {
		return nil, 0, err
	}

	args := append(append([]any{}, params...), pageSize, (page-1)*pageSize)
	rows, err := s.db.Query(
		codeSelect+" "+where+" ORDER BY codes.id DESC LIMIT ? OFFSET ?", args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	items, err := scanCodeRows(rows)
	return items, total, err
}

// CodeIDs 取筛选结果的全部卡密 id。
func (s *Store) CodeIDs(filter CodeFilter) ([]int64, error) {
	where, params := buildCodeWhere(filter)
	rows, err := s.db.Query(
		"SELECT codes.id FROM redeem_codes codes "+where+" ORDER BY codes.id DESC", params...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// CodeSelectionCount 返回筛选结果条数。
func (s *Store) CodeSelectionCount(filter CodeFilter) (int, error) {
	where, params := buildCodeWhere(filter)
	var total int
	err := s.db.QueryRow("SELECT COUNT(*) FROM redeem_codes codes "+where, params...).Scan(&total)
	return total, err
}

// CodesByIDs 批量取卡密。
func (s *Store) CodesByIDs(ids []int64) ([]Code, error) {
	if len(ids) == 0 {
		return []Code{}, nil
	}
	placeholders, args := placeholdersFor(ids)
	rows, err := s.db.Query(
		codeSelect+" WHERE codes.id IN ("+placeholders+") ORDER BY codes.id ASC", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanCodeRows(rows)
}

// CreateCodes 批量发卡，冲突时重试生成新码。
func (s *Store) CreateCodes(typeID int64, count, quantity int, note string, expiresAt *string) ([]Code, error) {
	emailType, err := s.RedeemTypeByID(typeID)
	if err != nil {
		return nil, err
	}
	if emailType == nil {
		return nil, errors.New("兑换类型不存在")
	}
	if count < 1 {
		count = 1
	}
	if quantity < 1 {
		quantity = 1
	}

	created := make([]Code, 0, count)
	err = s.inTx(func(tx *sql.Tx) error {
		for index := 0; index < count; index++ {
			inserted := false
			for attempt := 0; attempt < 50; attempt++ {
				code := domain.GenerateRedeemCode()
				normalized := domain.NormalizeRedeemCode(code)
				result, err := tx.Exec(`
					INSERT INTO redeem_codes (
						code, normalized_code, type_id, quantity, redeemed_quantity,
						note, status, expires_at, created_at, updated_at
					)
					VALUES (?, ?, ?, ?, 0, ?, 'unused', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
				`, code, normalized, typeID, quantity, note, expiresAt)
				if err != nil {
					if strings.Contains(strings.ToUpper(err.Error()), "UNIQUE") {
						continue
					}
					return err
				}
				id, err := result.LastInsertId()
				if err != nil {
					return err
				}
				created = append(created, Code{
					ID:                id,
					Code:              code,
					NormalizedCode:    normalized,
					TypeID:            typeID,
					TypeName:          emailType.Name,
					TypeSlug:          emailType.Slug,
					Quantity:          quantity,
					RedeemedQuantity:  0,
					RemainingQuantity: quantity,
					Note:              note,
					Status:            "unused",
					DerivedStatus:     "unused",
					ExpiresAt:         expiresAt,
					CreatedAt:         Now(),
					UpdatedAt:         Now(),
				})
				inserted = true
				break
			}
			if !inserted {
				return errors.New("生成兑换码冲突过多，请稍后重试")
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return created, nil
}

// UpdateCodeStatus 在 disabled / unused 之间切换。
func (s *Store) UpdateCodeStatus(codeID int64, status string) (*Code, error) {
	nextStatus := "unused"
	if status == "disabled" {
		nextStatus = "disabled"
	}

	result, err := s.db.Exec(`
		UPDATE redeem_codes SET status = ?, updated_at = CURRENT_TIMESTAMP
		WHERE id = ? AND status <> 'redeemed'
	`, nextStatus, codeID)
	if err != nil {
		return nil, err
	}
	if changes, _ := result.RowsAffected(); changes == 0 {
		current, err := s.CodeByID(codeID)
		if err != nil {
			return nil, err
		}
		if current == nil {
			return nil, nil
		}
		if current.Status == "redeemed" {
			return nil, errors.New("已兑换的卡密不能修改状态")
		}
	}
	return s.CodeByID(codeID)
}

// DeleteCode 删除单张卡密；已兑换的卡密要留着对账，直接报错。
func (s *Store) DeleteCode(codeID int64) (bool, error) {
	var status string
	err := s.db.QueryRow("SELECT status FROM redeem_codes WHERE id = ? LIMIT 1", codeID).Scan(&status)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if status == "redeemed" {
		return false, errors.New("已兑换的卡密不能删除")
	}

	result, err := s.db.Exec("DELETE FROM redeem_codes WHERE id = ?", codeID)
	if err != nil {
		return false, err
	}
	changes, _ := result.RowsAffected()
	return changes > 0, nil
}

// RollbackCode 回退已兑换的卡密：库存回到可售，记录与卡密一起删除。
func (s *Store) RollbackCode(codeID int64) (map[string]any, error) {
	var output map[string]any

	err := s.inTx(func(tx *sql.Tx) error {
		var status string
		err := tx.QueryRow("SELECT status FROM redeem_codes WHERE id = ?", codeID).Scan(&status)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		if status != "redeemed" {
			return errors.New("只有已兑换的卡密可以回退")
		}

		restored, err := tx.Exec(`
			UPDATE redeem_inventory
			SET status = 'available', redeemed_code_id = NULL, redeemed_at = NULL,
			    updated_at = CURRENT_TIMESTAMP
			WHERE redeemed_code_id = ?
		`, codeID)
		if err != nil {
			return err
		}
		restoredByCode, _ := restored.RowsAffected()

		// 兜底：库存行的 redeemed_code_id 可能与记录不一致，按记录再修一次。
		rows, err := tx.Query("SELECT inventory_id FROM redeem_records WHERE code_id = ?", codeID)
		if err != nil {
			return err
		}
		inventoryIDs := []int64{}
		for rows.Next() {
			var id int64
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			inventoryIDs = append(inventoryIDs, id)
		}
		rows.Close()

		var restoredByRecord int64
		for _, inventoryID := range inventoryIDs {
			result, err := tx.Exec(`
				UPDATE redeem_inventory
				SET status = 'available', redeemed_code_id = NULL, redeemed_at = NULL,
				    updated_at = CURRENT_TIMESTAMP
				WHERE id = ? AND status = 'redeemed'
			`, inventoryID)
			if err != nil {
				return err
			}
			changes, _ := result.RowsAffected()
			restoredByRecord += changes
		}

		deletedRecords, err := tx.Exec("DELETE FROM redeem_records WHERE code_id = ?", codeID)
		if err != nil {
			return err
		}
		deletedRecordCount, _ := deletedRecords.RowsAffected()

		if _, err := tx.Exec("DELETE FROM redeem_codes WHERE id = ?", codeID); err != nil {
			return err
		}

		output = map[string]any{
			"code_id":                codeID,
			"restored_inventory_count": restoredByCode + restoredByRecord,
			"deleted_record_count":   deletedRecordCount,
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return output, nil
}

const recordSelect = `
  SELECT
    records.id,
    records.code_id,
    records.inventory_id,
    records.requester_ip,
    records.requester_user_agent,
    records.redeemed_at,
    COALESCE(inventory.serialized_value, records.payload_raw) AS payload_raw,
    codes.type_id,
    codes.code,
    codes.normalized_code,
    types.name AS type_name,
    types.slug AS type_slug,
    types.description AS type_description,
    types.field_schema,
    types.mail_protocol,
    types.mail_protocols AS type_mail_protocols,
    inventory.pickup_protocols,
    types.import_delimiter
  FROM redeem_records records
  JOIN redeem_codes codes ON codes.id = records.code_id
  JOIN redeem_email_types types ON types.id = codes.type_id
  LEFT JOIN redeem_inventory inventory ON inventory.id = records.inventory_id
`

// RecordsByCodeID 取某个卡密的全部兑换记录。
func (s *Store) RecordsByCodeID(codeID int64) ([]Record, error) {
	rows, err := s.db.Query(recordSelect+" WHERE records.code_id = ? ORDER BY records.id ASC", codeID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanRecordRows(rows)
}

// RecordGroup 是后台记录列表按卡密聚合的一行。
type RecordGroup struct {
	CodeID       int64  `json:"code_id"`
	TypeID       int64  `json:"type_id"`
	Code         string `json:"code"`
	NormalizedCode string `json:"normalized_code"`
	TypeName     string `json:"type_name"`
	TypeSlug     string `json:"type_slug"`
	MailProtocol string `json:"mail_protocol"`
	ItemCount    int    `json:"item_count"`
	RedeemedAt   string `json:"redeemed_at"`
	RequesterIP  string `json:"requester_ip"`
	RequesterAgent string `json:"requester_user_agent"`
}

// ListRecordGroups 后台兑换记录列表（按卡密聚合）。
func (s *Store) ListRecordGroups(typeID int64, query string, page, pageSize int) ([]RecordGroup, int, error) {
	conditions := make([]string, 0, 2)
	params := make([]any, 0, 3)
	if typeID > 0 {
		conditions = append(conditions, "codes.type_id = ?")
		params = append(params, typeID)
	}
	if text := strings.TrimSpace(query); text != "" {
		conditions = append(conditions,
			"(codes.normalized_code LIKE ? OR inventory.search_text LIKE ?)")
		params = append(params, "%"+domain.NormalizeRedeemCode(text)+"%",
			"%"+strings.ToLower(text)+"%")
	}

	where := ""
	if len(conditions) > 0 {
		where = "WHERE " + strings.Join(conditions, " AND ")
	}
	// 只有关键词检索需要回表到库存匹配 search_text。
	inventoryJoin := ""
	if strings.TrimSpace(query) != "" {
		inventoryJoin = "LEFT JOIN redeem_inventory inventory ON inventory.id = records.inventory_id"
	}
	codesJoin := ""
	if len(conditions) > 0 {
		codesJoin = "JOIN redeem_codes codes ON codes.id = records.code_id"
	}

	var total int
	countQuery := `
		SELECT COUNT(DISTINCT records.code_id)
		FROM redeem_records records
		` + codesJoin + `
		` + inventoryJoin + `
		` + where
	if err := s.db.QueryRow(countQuery, params...).Scan(&total); err != nil {
		return nil, 0, err
	}

	listQuery := `
		SELECT
			records.code_id,
			codes.type_id,
			codes.code,
			codes.normalized_code,
			types.name AS type_name,
			types.slug AS type_slug,
			types.mail_protocol,
			COUNT(records.id) AS item_count,
			MAX(records.redeemed_at) AS redeemed_at,
			MAX(records.requester_ip) AS requester_ip,
			MAX(records.requester_user_agent) AS requester_user_agent
		FROM redeem_records records
		` + inventoryJoin + `
		JOIN redeem_codes codes ON codes.id = records.code_id
		JOIN redeem_email_types types ON types.id = codes.type_id
		` + where + `
		GROUP BY records.code_id
		ORDER BY MAX(records.id) DESC
		LIMIT ? OFFSET ?
	`
	args := append(append([]any{}, params...), pageSize, (page-1)*pageSize)
	rows, err := s.db.Query(listQuery, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	items := []RecordGroup{}
	for rows.Next() {
		var item RecordGroup
		var redeemedAt, requesterIP, requesterAgent sql.NullString
		if err := rows.Scan(
			&item.CodeID, &item.TypeID, &item.Code, &item.NormalizedCode,
			&item.TypeName, &item.TypeSlug, &item.MailProtocol, &item.ItemCount,
			&redeemedAt, &requesterIP, &requesterAgent,
		); err != nil {
			return nil, 0, err
		}
		item.RedeemedAt = NullString(redeemedAt)
		item.RequesterIP = NullString(requesterIP)
		item.RequesterAgent = NullString(requesterAgent)
		items = append(items, item)
	}
	return items, total, rows.Err()
}

// AccessExpiresAt 返回兑换结果的失效时间。
func (s *Store) AccessExpiresAt(redeemedAt string) *string {
	parsed, ok := parseTimestamp(redeemedAt)
	if !ok {
		return nil
	}
	value := parsed.Add(s.cfg.RedeemAccessTTL).UTC().Format(time.RFC3339)
	return &value
}

// AccessExpired 判断是否超过取件窗口。
func (s *Store) AccessExpired(redeemedAt string) bool {
	parsed, ok := parseTimestamp(redeemedAt)
	if !ok {
		return false
	}
	return !time.Now().Before(parsed.Add(s.cfg.RedeemAccessTTL))
}

// AccessTTLHours 返回窗口小时数（保留一位小数）。
func (s *Store) AccessTTLHours() float64 {
	hours := s.cfg.RedeemAccessTTL.Hours()
	return float64(int(hours*10+0.5)) / 10
}

// parseTimestamp 兼容 SQLite 的 "YYYY-MM-DD HH:MM:SS"（UTC）与 ISO 串。
func parseTimestamp(value string) (time.Time, bool) {
	text := strings.TrimSpace(value)
	if text == "" {
		return time.Time{}, false
	}
	layouts := []string{
		"2006-01-02 15:04:05",
		"2006-01-02T15:04:05Z07:00",
		time.RFC3339Nano,
		"2006-01-02 15:04:05.000",
	}
	for _, layout := range layouts {
		if parsed, err := time.Parse(layout, text); err == nil {
			return parsed.UTC(), true
		}
	}
	return time.Time{}, false
}

// RedeemByCode 兑换主流程：单事务内锁定库存、写记录、更新卡密状态。
func (s *Store) RedeemByCode(normalizedCode, requesterIP, requesterAgent string) (*RedeemResult, error) {
	if normalizedCode == "" {
		return nil, errors.New("请输入兑换码")
	}

	var output *RedeemResult
	err := s.inTx(func(tx *sql.Tx) error {
		var (
			codeID            int64
			codeText          string
			codeNormalized    string
			status            string
			quantity          int
			expiresAt         sqliteText
			redeemedAt        sqliteText
			dataDeletedAt     sqliteText
			typeID            int64
			typeName          string
			typeSlug          string
			typeDescription   sql.NullString
			fieldSchema       string
			mailProtocol      string
			mailProtocols     string
			importDelimiter   string
		)

		err := tx.QueryRow(`
			SELECT
				codes.id, codes.code, codes.normalized_code, codes.status, codes.quantity,
				codes.expires_at, codes.redeemed_at, codes.data_deleted_at,
				types.id AS type_id, types.name AS type_name, types.slug AS type_slug,
				types.description, types.field_schema, types.mail_protocol,
				types.mail_protocols, types.import_delimiter
			FROM redeem_codes codes
			JOIN redeem_email_types types ON types.id = codes.type_id
			WHERE codes.normalized_code = ?
			LIMIT 1
		`, normalizedCode).Scan(
			&codeID, &codeText, &codeNormalized, &status, &quantity,
			&expiresAt, &redeemedAt, &dataDeletedAt,
			&typeID, &typeName, &typeSlug, &typeDescription, &fieldSchema,
			&mailProtocol, &mailProtocols, &importDelimiter,
		)
		if errors.Is(err, sql.ErrNoRows) {
			return errors.New("兑换码不存在")
		}
		if err != nil {
			return err
		}
		if status == "disabled" {
			return errors.New("兑换码已禁用")
		}

		emailType := RedeemTypeView{
			RedeemEmailType: domain.RedeemEmailType{
				ID:              typeID,
				Slug:            typeSlug,
				Name:            typeName,
				Description:     NullString(typeDescription),
				FieldSchema:     domain.ParseFieldSchema(fieldSchema),
				MailProtocol:    mailProtocol,
				MailProtocols:   domain.NormalizeMailProtocols(mailProtocols, []string{mailProtocol}),
				ImportDelimiter: importDelimiter,
			},
		}
		emailType.MailProtocol = emailType.MailProtocols[0]

		if status == "redeemed" {
			// 已兑换：24 小时内重放同一卡密要拿到同样的结果（幂等）。
			if dataDeletedAt.Valid || s.AccessExpired(redeemedAt.Value) {
				return errors.New("兑换已超过24小时，账号信息已删除；取件请手动导入账号数据")
			}
			result, err := s.existingRedeemResult(tx, codeID, emailType)
			if err != nil {
				return err
			}
			output = result
			return nil
		}

		if expiresAt.Valid && expiresAt.Value != "" {
			if parsed, ok := parseTimestamp(expiresAt.Value); ok && !time.Now().Before(parsed) {
				return errors.New("兑换码已过期")
			}
		}

		allowed := domain.NormalizeMailProtocols(emailType.MailProtocols, []string{emailType.MailProtocol})
		if quantity < 1 {
			quantity = 1
		}

		var inventoryRows []Inventory
		selectedProtocol := ""
		for _, protocol := range allowed {
			rows, err := tx.Query(
				"SELECT "+inventoryColumns+" FROM redeem_inventory inventory"+
					" WHERE inventory.type_id = ? AND inventory.status = 'available'"+
					" AND inventory.pickup_"+protocol+" = 1 ORDER BY inventory.id ASC LIMIT ?",
				typeID, quantity)
			if err != nil {
				return err
			}
			candidates, err := scanInventoryBaseRows(rows)
			rows.Close()
			if err != nil {
				return err
			}
			if len(candidates) >= quantity {
				selectedProtocol = protocol
				inventoryRows = candidates
				break
			}
		}

		if selectedProtocol == "" {
			// 失败路径才统计，用于给出可读的库存提示。
			summary := make([]string, 0, len(allowed))
			for _, protocol := range allowed {
				var count int
				if err := tx.QueryRow(
					"SELECT COUNT(*) FROM redeem_inventory WHERE type_id = ? AND status = 'available' AND pickup_"+
						protocol+" = 1", typeID).Scan(&count); err != nil {
					return err
				}
				label := "IMAP"
				if protocol == "graph" {
					label = "Graph"
				}
				summary = append(summary, fmt.Sprintf("%s %d 份", label, count))
			}
			return fmt.Errorf("当前类型没有单一协议的足够库存，至少需要 %d 份（%s）",
				quantity, strings.Join(summary, "，"))
		}
		if len(inventoryRows) < quantity {
			return errors.New("库存领取冲突，请稍后重试")
		}

		// 兑换结果里的库存需要带上类型视图：取件端要按 field_schema 渲染、
		// 按 import_delimiter 拼行，而基础列查询里没有这些。
		for index := range inventoryRows {
			inventoryRows[index].TypeName = emailType.Name
			inventoryRows[index].TypeSlug = emailType.Slug
			inventoryRows[index].FieldSchema = emailType.FieldSchema
			inventoryRows[index].TypeMailProtocols = emailType.MailProtocols
			inventoryRows[index].ImportDelimiter = emailType.ImportDelimiter
			if inventoryRows[index].ImportDelimiter == "" {
				inventoryRows[index].ImportDelimiter = "----"
			}
		}

		redeemedAtValue := Now()
		for index := range inventoryRows {
			result, err := tx.Exec(`
				UPDATE redeem_inventory
				SET status = 'redeemed', redeemed_code_id = ?, redeemed_at = ?,
				    updated_at = CURRENT_TIMESTAMP
				WHERE id = ? AND status = 'available'
			`, codeID, redeemedAtValue, inventoryRows[index].ID)
			if err != nil {
				return err
			}
			if changes, _ := result.RowsAffected(); changes == 0 {
				return errors.New("库存领取失败，请稍后重试")
			}

			recordResult, err := tx.Exec(`
				INSERT INTO redeem_records (
					code_id, inventory_id, requester_ip, requester_user_agent, redeemed_at
				) VALUES (?, ?, ?, ?, ?)
			`, codeID, inventoryRows[index].ID, requesterIP, requesterAgent, redeemedAtValue)
			if err != nil {
				return err
			}
			recordID, err := recordResult.LastInsertId()
			if err != nil {
				return err
			}
			if output == nil {
				output = &RedeemResult{}
			}
			output.RecordIDs = append(output.RecordIDs, recordID)

			inventoryRows[index].Status = "redeemed"
			inventoryRows[index].RedeemedCodeID = &codeID
			inventoryRows[index].RedeemedAt = &redeemedAtValue
		}

		codeUpdate, err := tx.Exec(`
			UPDATE redeem_codes
			SET status = 'redeemed', redeemed_inventory_id = ?, redeemed_quantity = ?,
			    redeemed_at = ?, updated_at = CURRENT_TIMESTAMP
			WHERE id = ? AND status = 'unused'
		`, inventoryRows[0].ID, quantity, redeemedAtValue, codeID)
		if err != nil {
			return err
		}
		if changes, _ := codeUpdate.RowsAffected(); changes == 0 {
			return errors.New("兑换码状态更新失败，请稍后重试")
		}

		firstRecordID := int64(0)
		if len(output.RecordIDs) > 0 {
			firstRecordID = output.RecordIDs[0]
		}
		var recordIDPtr *int64
		if firstRecordID > 0 {
			recordIDPtr = &firstRecordID
		}
		redeemedAtPtr := redeemedAtValue
		output.RecordID = recordIDPtr
		output.RedeemedCount = quantity
		output.Inventories = inventoryRows
		output.Type = emailType
		output.Code = Code{
			ID:                  codeID,
			Code:                codeText,
			NormalizedCode:      codeNormalized,
			TypeID:              typeID,
			TypeName:            typeName,
			TypeSlug:            typeSlug,
			Quantity:            quantity,
			RedeemedQuantity:    quantity,
			RemainingQuantity:   0,
			Status:              "redeemed",
			DerivedStatus:       "redeemed",
			RedeemedInventoryID: &inventoryRows[0].ID,
			RedeemedAt:          &redeemedAtPtr,
			ExpiresAt:           textPtr(expiresAt),
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return output, nil
}

// existingRedeemResult 复现「同一卡密再次打开」的幂等结果。
func (s *Store) existingRedeemResult(tx *sql.Tx, codeID int64, emailType RedeemTypeView) (*RedeemResult, error) {
	// 卡密本体要一起回给前端（兑换结果里有 code 字段），这里按 id 再取一次。
	codeRows, err := tx.Query(codeSelect+" WHERE codes.id = ? LIMIT 1", codeID)
	if err != nil {
		return nil, err
	}
	codes, err := scanCodeRows(codeRows)
	codeRows.Close()
	if err != nil {
		return nil, err
	}
	if len(codes) == 0 {
		return nil, errors.New("兑换码不存在")
	}
	code := codes[0]

	rows, err := tx.Query(recordSelect+" WHERE records.code_id = ? ORDER BY records.id ASC", codeID)
	if err != nil {
		return nil, err
	}
	records, err := scanRecordRows(rows)
	rows.Close()
	if err != nil {
		return nil, err
	}

	redeemedAt := ""
	if code.RedeemedAt != nil {
		redeemedAt = *code.RedeemedAt
	}

	if len(records) == 0 {
		// 没有记录时退回按库存的 redeemed_code_id 找，兼容早期只标库存的库。
		inventoryRows, err := tx.Query(inventorySelect+`
			WHERE inventory.redeemed_code_id = ?
			   OR (? IS NOT NULL AND inventory.id = ?)
			ORDER BY inventory.id ASC
		`, codeID, code.RedeemedInventoryID, code.RedeemedInventoryID)
		if err != nil {
			return nil, err
		}
		inventories, err := scanInventoryRows(inventoryRows)
		inventoryRows.Close()
		if err != nil {
			return nil, err
		}
		if len(inventories) == 0 {
			return nil, errors.New("兑换码已兑换，但没有可查询的兑换结果")
		}
		if redeemedAt == "" {
			for _, item := range inventories {
				if item.RedeemedAt != nil {
					redeemedAt = *item.RedeemedAt
					break
				}
			}
		}
		code.Status = "redeemed"
		if code.RedeemedQuantity < len(inventories) {
			code.RedeemedQuantity = len(inventories)
		}
		code.RemainingQuantity = code.Quantity - code.RedeemedQuantity
		if code.RedeemedInventoryID == nil {
			firstInventoryID := inventories[0].ID
			code.RedeemedInventoryID = &firstInventoryID
		}
		if redeemedAt != "" {
			code.RedeemedAt = &redeemedAt
		}
		return &RedeemResult{
			RedeemedCount: len(inventories),
			Code:          code,
			Inventories:   inventories,
			Type:          emailType,
		}, nil
	}

	inventories := make([]Inventory, 0, len(records))
	recordIDs := make([]int64, 0, len(records))
	for _, record := range records {
		recordIDs = append(recordIDs, record.ID)
		mailProtocols := domain.NormalizeMailProtocols(record.MailProtocols, []string{record.MailProtocol})
		inventories = append(inventories, Inventory{
			ID:                record.InventoryID,
			TypeID:            record.TypeID,
			TypeName:          record.TypeName,
			TypeSlug:          record.TypeSlug,
			FieldSchema:       record.FieldSchema,
			MailProtocols:     mailProtocols,
			MailProtocol:      mailProtocols[0],
			TypeMailProtocols: record.TypeMailProtocols,
			ImportDelimiter:   record.ImportDelimiter,
			Payload:           record.Payload,
			Status:            "redeemed",
			RedeemedCodeID:    &codeID,
			RedeemedAt:        &record.RedeemedAt,
		})
	}

	firstRecordID := recordIDs[0]
	code.Status = "redeemed"
	if code.RedeemedQuantity < len(records) {
		code.RedeemedQuantity = len(records)
	}
	code.RemainingQuantity = code.Quantity - code.RedeemedQuantity
	if code.RedeemedInventoryID == nil {
		firstInventoryID := records[0].InventoryID
		code.RedeemedInventoryID = &firstInventoryID
	}
	if redeemedAt == "" {
		redeemedAt = records[0].RedeemedAt
	}
	if redeemedAt != "" {
		code.RedeemedAt = &redeemedAt
	}

	return &RedeemResult{
		RecordID:      &firstRecordID,
		RecordIDs:     recordIDs,
		RedeemedCount: len(records),
		Code:          code,
		Inventories:   inventories,
		Type:          emailType,
	}, nil
}

// textPtr 把 sqliteText 转成可空字符串指针。
func textPtr(value sqliteText) *string {
	if !value.Valid || value.Value == "" {
		return nil
	}
	text := value.Value
	return &text
}

func nullableString(value sql.NullString) *string {
	if !value.Valid || value.String == "" {
		return nil
	}
	return &value.String
}

func protocolFlags(protocols []string) (int, int) {
	imap, graph := 0, 0
	for _, protocol := range protocols {
		if protocol == "imap" {
			imap = 1
		}
		if protocol == "graph" {
			graph = 1
		}
	}
	return imap, graph
}

func sameSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for _, item := range a {
		if !contains(b, item) {
			return false
		}
	}
	return true
}

func placeholdersFor(ids []int64) (string, []any) {
	placeholders := make([]string, len(ids))
	args := make([]any, len(ids))
	for index, id := range ids {
		placeholders[index] = "?"
		args[index] = id
	}
	return strings.Join(placeholders, ","), args
}

// RecordsByCodeIDPaged 分页取兑换记录。
func (s *Store) RecordsByCodeIDPaged(codeID int64, page, pageSize int) ([]Record, int, error) {
	var total int
	if err := s.db.QueryRow(
		"SELECT COUNT(*) FROM redeem_records WHERE code_id = ?", codeID).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := s.db.Query(
		recordSelect+" WHERE records.code_id = ? ORDER BY records.id ASC LIMIT ? OFFSET ?",
		codeID, pageSize, (page-1)*pageSize)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	items, err := scanRecordRows(rows)
	return items, total, err
}
