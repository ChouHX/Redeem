package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"

	"github.com/redeem/backend/internal/domain"
)

// ProtocolCounts 是按协议拆分的可用库存数。
type ProtocolCounts struct {
	IMAP  int `json:"imap"`
	Graph int `json:"graph"`
}

// RedeemTypeView 是带库存/卡密计数的类型视图，字段名与 Node 输出一致。
type RedeemTypeView struct {
	domain.RedeemEmailType
	AvailableInventoryCount int            `json:"available_inventory_count"`
	AvailableByProtocol     ProtocolCounts `json:"available_inventory_by_protocol"`
	AvailableCodeCount      int            `json:"available_code_count"`
	RedeemedCount           int            `json:"redeemed_count"`
}

// 老库里 mail_protocol / mail_protocols 是后来 ALTER 加的，t.* 的列序不可依赖，
// 这里显式列名，顺序与 scanRedeemType 一致。
const redeemTypeSelect = `
  SELECT
    t.id,
    t.slug,
    t.name,
    t.description,
    t.field_schema,
    t.mail_protocol,
    t.mail_protocols,
    t.import_delimiter,
    t.is_active,
    t.created_at,
    t.updated_at,
    (
      SELECT COUNT(*) FROM redeem_inventory inventory
      WHERE inventory.type_id = t.id AND inventory.status = 'available'
    ) AS available_inventory_count,
    (
      SELECT COUNT(*) FROM redeem_inventory inventory
      WHERE inventory.type_id = t.id AND inventory.status = 'available' AND inventory.pickup_imap = 1
    ) AS available_imap_inventory_count,
    (
      SELECT COUNT(*) FROM redeem_inventory inventory
      WHERE inventory.type_id = t.id AND inventory.status = 'available' AND inventory.pickup_graph = 1
    ) AS available_graph_inventory_count,
    (
      SELECT COUNT(*) FROM redeem_codes codes
      WHERE codes.type_id = t.id AND codes.status = 'unused'
        AND (codes.expires_at IS NULL OR codes.expires_at > CURRENT_TIMESTAMP)
    ) AS available_code_count,
    (
      SELECT COUNT(*) FROM redeem_codes codes
      JOIN redeem_records records ON records.code_id = codes.id
      WHERE codes.type_id = t.id
    ) AS redeemed_count
  FROM redeem_email_types t
`

// GetSystemConfig 返回对外暴露的系统配置。
func (s *Store) GetSystemConfig() (map[string]any, error) {
	value, ok, err := s.GetSystemConfigValue("email_limit")
	if err != nil {
		return nil, err
	}
	limit := s.cfg.DefaultEmailLimit
	if ok {
		if parsed, convErr := strconv.Atoi(value); convErr == nil {
			limit = parsed
		}
	}
	return map[string]any{"email_limit": limit}, nil
}

// GetSystemConfigValue 读单个配置项。
func (s *Store) GetSystemConfigValue(key string) (string, bool, error) {
	var value string
	err := s.db.QueryRow("SELECT value FROM system_config WHERE key = ?", key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return value, true, nil
}

// SetSystemConfigValue 写入单个配置项。
func (s *Store) SetSystemConfigValue(key, value string) error {
	_, err := s.db.Exec(`
		INSERT INTO system_config (key, value, updated_at)
		VALUES (?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
	`, key, value)
	return err
}

// ListRedeemTypes 按 id 升序返回类型。
func (s *Store) ListRedeemTypes(includeInactive bool) ([]RedeemTypeView, error) {
	query := redeemTypeSelect
	if !includeInactive {
		query += " WHERE t.is_active = 1"
	}
	query += " ORDER BY t.id ASC"

	rows, err := s.db.Query(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	views := []RedeemTypeView{}
	for rows.Next() {
		view, err := scanRedeemType(rows)
		if err != nil {
			return nil, err
		}
		views = append(views, *view)
	}
	return views, rows.Err()
}

// RedeemTypeByID 按主键取类型。
func (s *Store) RedeemTypeByID(id int64) (*RedeemTypeView, error) {
	row := s.db.QueryRow(redeemTypeSelect+" WHERE t.id = ? LIMIT 1", id)
	view, err := scanRedeemType(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return view, err
}

// RedeemTypeBySlug 按 slug 取类型。
func (s *Store) RedeemTypeBySlug(slug string) (*RedeemTypeView, error) {
	row := s.db.QueryRow(redeemTypeSelect+" WHERE t.slug = ? LIMIT 1", slug)
	view, err := scanRedeemType(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return view, err
}

// CreateRedeemType 新建类型。
func (s *Store) CreateRedeemType(input domain.RedeemEmailType) (*RedeemTypeView, error) {
	protocols := domain.NormalizeMailProtocols(input.MailProtocols, []string{input.MailProtocol})
	schemaJSON, err := json.Marshal(input.FieldSchema)
	if err != nil {
		return nil, err
	}
	protocolsJSON, err := json.Marshal(protocols)
	if err != nil {
		return nil, err
	}
	delimiter := input.ImportDelimiter
	if delimiter == "" {
		delimiter = "----"
	}

	result, err := s.db.Exec(`
		INSERT INTO redeem_email_types (
			slug, name, description, field_schema, mail_protocol, mail_protocols,
			import_delimiter, is_active, created_at, updated_at
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
	`, input.Slug, input.Name, input.Description, string(schemaJSON), protocols[0],
		string(protocolsJSON), delimiter, boolToInt(input.IsActive))
	if err != nil {
		return nil, err
	}
	id, err := result.LastInsertId()
	if err != nil {
		return nil, err
	}
	return s.RedeemTypeByID(id)
}

// UpdateRedeemType 全量更新类型。
func (s *Store) UpdateRedeemType(id int64, input domain.RedeemEmailType) (*RedeemTypeView, error) {
	protocols := domain.NormalizeMailProtocols(input.MailProtocols, []string{input.MailProtocol})
	schemaJSON, err := json.Marshal(input.FieldSchema)
	if err != nil {
		return nil, err
	}
	protocolsJSON, err := json.Marshal(protocols)
	if err != nil {
		return nil, err
	}
	delimiter := input.ImportDelimiter
	if delimiter == "" {
		delimiter = "----"
	}

	result, err := s.db.Exec(`
		UPDATE redeem_email_types
		SET slug = ?, name = ?, description = ?, field_schema = ?, mail_protocol = ?,
		    mail_protocols = ?, import_delimiter = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, input.Slug, input.Name, input.Description, string(schemaJSON), protocols[0],
		string(protocolsJSON), delimiter, boolToInt(input.IsActive), id)
	if err != nil {
		return nil, err
	}
	changes, err := result.RowsAffected()
	if err != nil {
		return nil, err
	}
	if changes == 0 {
		return nil, nil
	}
	return s.RedeemTypeByID(id)
}

// DeleteTypeResult 是删除类型的级联统计。
type DeleteTypeResult struct {
	Type                  *RedeemTypeView `json:"type"`
	DeletedTypeCount      int64           `json:"deleted_type_count"`
	DeletedInventoryCount int64           `json:"deleted_inventory_count"`
	DeletedCodeCount      int64           `json:"deleted_code_count"`
	DeletedRecordCount    int64           `json:"deleted_record_count"`
}

// DeleteRedeemType 级联删除类型及其库存、卡密、记录。
func (s *Store) DeleteRedeemType(id int64) (*DeleteTypeResult, error) {
	if id < 1 {
		return nil, nil
	}

	var result *DeleteTypeResult
	err := s.inTx(func(tx *sql.Tx) error {
		current, err := s.RedeemTypeByID(id)
		if err != nil {
			return err
		}
		if current == nil {
			return nil
		}

		recordResult, err := tx.Exec(
			`DELETE FROM redeem_records WHERE code_id IN (SELECT id FROM redeem_codes WHERE type_id = ?)`, id)
		if err != nil {
			return err
		}
		inventoryResult, err := tx.Exec("DELETE FROM redeem_inventory WHERE type_id = ?", id)
		if err != nil {
			return err
		}
		codeResult, err := tx.Exec("DELETE FROM redeem_codes WHERE type_id = ?", id)
		if err != nil {
			return err
		}
		typeResult, err := tx.Exec("DELETE FROM redeem_email_types WHERE id = ?", id)
		if err != nil {
			return err
		}

		typeCount, _ := typeResult.RowsAffected()
		if typeCount != 1 {
			return errors.New("兑换类型删除失败")
		}
		inventoryCount, _ := inventoryResult.RowsAffected()
		codeCount, _ := codeResult.RowsAffected()
		recordCount, _ := recordResult.RowsAffected()

		result = &DeleteTypeResult{
			Type:                  current,
			DeletedTypeCount:      typeCount,
			DeletedInventoryCount: inventoryCount,
			DeletedCodeCount:      codeCount,
			DeletedRecordCount:    recordCount,
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

// EnsureDefaultRedeemType 保证默认类型存在。
func (s *Store) EnsureDefaultRedeemType() (*RedeemTypeView, error) {
	existing, err := s.RedeemTypeBySlug(domain.DefaultRedeemEmailType.Slug)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		return existing, nil
	}
	return s.CreateRedeemType(domain.DefaultRedeemEmailType)
}

// AdminOverview 是后台概览，字段名与 getRedeemAdminOverview 一致（扁平结构）。
type AdminOverview struct {
	TypeCount                 int `json:"type_count"`
	TotalInventoryCount       int `json:"total_inventory_count"`
	AvailableInventoryCount   int `json:"available_inventory_count"`
	UnavailableInventoryCount int `json:"unavailable_inventory_count"`
	RedeemedInventoryCount    int `json:"redeemed_inventory_count"`
	TotalCodeCount            int `json:"total_code_count"`
	UnusedCodeCount           int `json:"unused_code_count"`
	RedeemedCodeCount         int `json:"redeemed_code_count"`
	DisabledCodeCount         int `json:"disabled_code_count"`
	RecordCount               int `json:"record_count"`
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanRedeemType(row rowScanner) (*RedeemTypeView, error) {
	var (
		id               int64
		slug             string
		name             string
		description      sql.NullString
		fieldSchema      string
		mailProtocol     string
		mailProtocols    string
		importDelimiter  string
		isActive         int64
		// created_at/updated_at 声明成 TIMESTAMP，驱动会转成 time.Time，
		// 直接扫进 string 会变成 RFC3339（2026-10-24T17:20:37Z），
		// 与 Node 读到的 "2026-10-24 17:20:37" 不一致。
		createdAt        sqliteText
		updatedAt        sqliteText
		availableTotal   int
		availableIMAP    int
		availableGraph   int
		availableCodes   int
		redeemedCount    int
	)

	if err := row.Scan(
		&id, &slug, &name, &description, &fieldSchema, &mailProtocol, &mailProtocols,
		&importDelimiter, &isActive, &createdAt, &updatedAt,
		&availableTotal, &availableIMAP, &availableGraph, &availableCodes, &redeemedCount,
	); err != nil {
		return nil, err
	}

	protocols := domain.NormalizeMailProtocols(mailProtocols, []string{mailProtocol})
	return &RedeemTypeView{
		RedeemEmailType: domain.RedeemEmailType{
			ID:              id,
			Slug:            slug,
			Name:            name,
			Description:     NullString(description),
			FieldSchema:     domain.ParseFieldSchema(fieldSchema),
			MailProtocol:    protocols[0],
			MailProtocols:   protocols,
			ImportDelimiter: importDelimiter,
			IsActive:        isActive != 0,
			CreatedAt:       createdAt.Value,
			UpdatedAt:       updatedAt.Value,
		},
		AvailableInventoryCount: availableTotal,
		AvailableByProtocol: ProtocolCounts{
			IMAP:  availableIMAP,
			Graph: availableGraph,
		},
		AvailableCodeCount: availableCodes,
		RedeemedCount:      redeemedCount,
	}, nil
}

// GetAdminOverview 汇总后台首屏需要的全部计数。
func (s *Store) GetAdminOverview() (AdminOverview, error) {
	var overview AdminOverview

	err := s.db.QueryRow(`
		SELECT
			COUNT(*) AS total,
			SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END) AS available,
			SUM(CASE WHEN status = 'unavailable' THEN 1 ELSE 0 END) AS unavailable,
			SUM(CASE WHEN status = 'redeemed' THEN 1 ELSE 0 END) AS redeemed
		FROM redeem_inventory
	`).Scan(
		&overview.TotalInventoryCount,
		&overview.AvailableInventoryCount,
		&overview.UnavailableInventoryCount,
		&overview.RedeemedInventoryCount,
	)
	if err != nil {
		return overview, err
	}

	if err := s.db.QueryRow(`
		SELECT
			COUNT(*) AS total,
			SUM(CASE WHEN status = 'unused' THEN 1 ELSE 0 END) AS unused,
			SUM(CASE WHEN status = 'redeemed' THEN 1 ELSE 0 END) AS redeemed,
			SUM(CASE WHEN status = 'disabled' THEN 1 ELSE 0 END) AS disabled
		FROM redeem_codes
	`).Scan(
		&overview.TotalCodeCount,
		&overview.UnusedCodeCount,
		&overview.RedeemedCodeCount,
		&overview.DisabledCodeCount,
	); err != nil {
		return overview, err
	}

	if err := s.db.QueryRow("SELECT COUNT(*) FROM redeem_email_types").Scan(&overview.TypeCount); err != nil {
		return overview, err
	}
	if err := s.db.QueryRow("SELECT COUNT(*) FROM redeem_records").Scan(&overview.RecordCount); err != nil {
		return overview, err
	}
	return overview, nil
}

func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func intToString(value int64) string { return fmt.Sprintf("%d", value) }
