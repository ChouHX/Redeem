package store

import (
	"database/sql"
	"time"

	"github.com/redeem/backend/internal/domain"
)

// sqliteText 兼容驱动的时间类型转换：
// modernc 会把声明为 TIMESTAMP 的列自动转成 time.Time，而 Node 侧拿到的是原始文本。
// 这里统一还原成 "YYYY-MM-DD HH:MM:SS"（UTC），保证两边输出一致。
type sqliteText struct {
	Value string
	Valid bool
}

// Scan 实现 sql.Scanner。
func (t *sqliteText) Scan(src any) error {
	switch value := src.(type) {
	case nil:
		t.Value, t.Valid = "", false
	case string:
		t.Value, t.Valid = value, true
	case []byte:
		t.Value, t.Valid = string(value), true
	case time.Time:
		t.Value, t.Valid = value.UTC().Format("2006-01-02 15:04:05"), true
	default:
		t.Value, t.Valid = "", false
	}
	return nil
}

// nullText 把可空文本列读成空串。
func nullText(value sqliteText) string {
	if value.Valid {
		return value.Value
	}
	return ""
}

// nullableText 把可空文本列读成指针（JSON 里是 null）。
func nullableText(value sqliteText) *string {
	if !value.Valid || value.Value == "" {
		return nil
	}
	result := value.Value
	return &result
}

// scanInventoryRows 按 inventoryColumns 的列序扫描。
func scanInventoryRows(rows *sql.Rows) ([]Inventory, error) {
	items := []Inventory{}
	for rows.Next() {
		var (
			item            Inventory
			serializedValue sqliteText
			searchText      sqliteText
			status          sqliteText
			pickupProtocols sqliteText
			redeemedCodeID  sql.NullInt64
			redeemedAt      sqliteText
			createdAt       sqliteText
			updatedAt       sqliteText
			typeName        sqliteText
			typeSlug        sqliteText
			fieldSchema     sqliteText
			mailProtocol    sqliteText
			typeProtocols   sqliteText
			importDelimiter sqliteText
		)

		if err := rows.Scan(
			&item.ID, &item.TypeID, &serializedValue, &searchText, &status,
			&pickupProtocols, &redeemedCodeID, &redeemedAt, &createdAt, &updatedAt,
			&typeName, &typeSlug, &fieldSchema, &mailProtocol, &typeProtocols, &importDelimiter,
		); err != nil {
			return nil, err
		}

		protocols := domain.NormalizeMailProtocols(
			nullText(pickupProtocols), []string{nullText(mailProtocol)})
		delimiter := nullText(importDelimiter)
		if delimiter == "" {
			delimiter = "----"
		}

		item.TypeName = nullText(typeName)
		item.TypeSlug = nullText(typeSlug)
		if schema := nullText(fieldSchema); schema != "" {
			item.FieldSchema = domain.ParseFieldSchema(schema)
		}
		item.MailProtocols = protocols
		item.MailProtocol = protocols[0]
		item.TypeMailProtocols = domain.NormalizeMailProtocols(
			nullText(typeProtocols), []string{nullText(mailProtocol)})
		item.ImportDelimiter = delimiter
		item.Payload = domain.RawLinePayload(nullText(serializedValue))
		item.SerializedValue = nullText(serializedValue)
		item.SearchText = nullText(searchText)
		item.Status = nullText(status)
		if redeemedCodeID.Valid {
			value := redeemedCodeID.Int64
			item.RedeemedCodeID = &value
		}
		item.RedeemedAt = nullableText(redeemedAt)
		item.CreatedAt = nullText(createdAt)
		item.UpdatedAt = nullText(updatedAt)

		items = append(items, item)
	}
	return items, rows.Err()
}

// scanCodeRows 按 codeColumns 的列序扫描。
func scanCodeRows(rows *sql.Rows) ([]Code, error) {
	items := []Code{}
	for rows.Next() {
		var (
			item              Code
			quantity          sql.NullInt64
			redeemedQuantity  sql.NullInt64
			note              sqliteText
			status            sqliteText
			expiresAt         sqliteText
			redeemedInventory sql.NullInt64
			redeemedAt        sqliteText
			createdAt         sqliteText
			updatedAt         sqliteText
			dataDeletedAt     sqliteText
			dataDeletedReason sqliteText
			typeName          sqliteText
			typeSlug          sqliteText
		)

		if err := rows.Scan(
			&item.ID, &item.Code, &item.NormalizedCode, &item.TypeID, &quantity,
			&redeemedQuantity, &note, &status, &expiresAt, &redeemedInventory,
			&redeemedAt, &createdAt, &updatedAt, &dataDeletedAt, &dataDeletedReason,
			&typeName, &typeSlug,
		); err != nil {
			return nil, err
		}

		qty := int(quantity.Int64)
		if qty < 1 {
			qty = 1
		}
		redeemed := int(redeemedQuantity.Int64)
		if redeemed < 0 {
			redeemed = 0
		}
		remaining := qty - redeemed
		if remaining < 0 {
			remaining = 0
		}

		item.TypeName = nullText(typeName)
		item.TypeSlug = nullText(typeSlug)
		item.Quantity = qty
		item.RedeemedQuantity = redeemed
		item.RemainingQuantity = remaining
		item.Note = nullText(note)
		item.Status = nullText(status)
		item.ExpiresAt = nullableText(expiresAt)
		if redeemedInventory.Valid {
			value := redeemedInventory.Int64
			item.RedeemedInventoryID = &value
		}
		item.RedeemedAt = nullableText(redeemedAt)
		item.DataDeletedAt = nullableText(dataDeletedAt)
		item.DataDeletedReason = nullText(dataDeletedReason)
		item.CreatedAt = nullText(createdAt)
		item.UpdatedAt = nullText(updatedAt)
		item.DerivedStatus = deriveCodeStatus(item)

		items = append(items, item)
	}
	return items, rows.Err()
}

// deriveCodeStatus 对应 deriveRedeemCodeStatus：未使用但已过期 → expired。
func deriveCodeStatus(code Code) string {
	if code.Status != "unused" || code.ExpiresAt == nil || *code.ExpiresAt == "" {
		return code.Status
	}
	parsed, ok := parseTimestamp(*code.ExpiresAt)
	if !ok {
		return code.Status
	}
	if !time.Now().Before(parsed) {
		return "expired"
	}
	return code.Status
}

// scanRecordRows 按 recordSelect 的列序扫描。
func scanRecordRows(rows *sql.Rows) ([]Record, error) {
	items := []Record{}
	for rows.Next() {
		var (
			item            Record
			requesterIP     sqliteText
			requesterAgent  sqliteText
			redeemedAt      sqliteText
			payloadRaw      sqliteText
			typeName        sqliteText
			typeSlug        sqliteText
			typeDescription sqliteText
			fieldSchema     sqliteText
			mailProtocol    sqliteText
			typeProtocols   sqliteText
			pickupProtocols sqliteText
			importDelimiter sqliteText
		)

		if err := rows.Scan(
			&item.ID, &item.CodeID, &item.InventoryID, &requesterIP, &requesterAgent,
			&redeemedAt, &payloadRaw, &item.TypeID, &item.Code, &item.NormalizedCode,
			&typeName, &typeSlug, &typeDescription, &fieldSchema, &mailProtocol,
			&typeProtocols, &pickupProtocols, &importDelimiter,
		); err != nil {
			return nil, err
		}

		protocols := domain.NormalizeMailProtocols(
			nullText(pickupProtocols), []string{nullText(mailProtocol)})
		delimiter := nullText(importDelimiter)
		if delimiter == "" {
			delimiter = "----"
		}

		item.TypeName = nullText(typeName)
		item.TypeSlug = nullText(typeSlug)
		item.TypeDescription = nullText(typeDescription)
		if schema := nullText(fieldSchema); schema != "" {
			item.FieldSchema = domain.ParseFieldSchema(schema)
		}
		item.MailProtocols = protocols
		item.MailProtocol = protocols[0]
		item.TypeMailProtocols = domain.NormalizeMailProtocols(
			nullText(typeProtocols), []string{nullText(mailProtocol)})
		item.ImportDelimiter = delimiter
		// 记录不再存账号副本：优先用库存行当前值，孤儿记录才退回快照。
		item.Payload = domain.RawLinePayload(nullText(payloadRaw))
		item.RequesterIP = nullText(requesterIP)
		item.RequesterAgent = nullText(requesterAgent)
		item.RedeemedAt = nullText(redeemedAt)

		items = append(items, item)
	}
	return items, rows.Err()
}

// scanInventoryBaseRows 只扫描 inventoryColumns 的 10 列（不带类型关联列），
// 兑换事务里用：类型信息已经在同一事务里读出来了。
func scanInventoryBaseRows(rows *sql.Rows) ([]Inventory, error) {
	items := []Inventory{}
	for rows.Next() {
		var (
			item            Inventory
			serializedValue sqliteText
			searchText      sqliteText
			status          sqliteText
			pickupProtocols sqliteText
			redeemedCodeID  sql.NullInt64
			redeemedAt      sqliteText
			createdAt       sqliteText
			updatedAt       sqliteText
		)
		if err := rows.Scan(
			&item.ID, &item.TypeID, &serializedValue, &searchText, &status,
			&pickupProtocols, &redeemedCodeID, &redeemedAt, &createdAt, &updatedAt,
		); err != nil {
			return nil, err
		}

		protocols := domain.NormalizeMailProtocols(nullText(pickupProtocols), nil)
		item.MailProtocols = protocols
		item.MailProtocol = protocols[0]
		item.Payload = domain.RawLinePayload(nullText(serializedValue))
		item.SerializedValue = nullText(serializedValue)
		item.SearchText = nullText(searchText)
		item.Status = nullText(status)
		if redeemedCodeID.Valid {
			value := redeemedCodeID.Int64
			item.RedeemedCodeID = &value
		}
		item.RedeemedAt = nullableText(redeemedAt)
		item.CreatedAt = nullText(createdAt)
		item.UpdatedAt = nullText(updatedAt)

		items = append(items, item)
	}
	return items, rows.Err()
}
