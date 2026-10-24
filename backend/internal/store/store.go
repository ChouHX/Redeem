// Package store 负责 SQLite 连接、结构与迁移，以及全部数据访问。
// 结构定义与 src/db.js 的建表语句逐字对应，两边可以打开同一个库文件。
package store

import (
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite"

	"github.com/redeem/backend/internal/config"
)

// Store 是数据访问入口。
type Store struct {
	db  *sql.DB
	cfg config.Config
}

// Open 打开库并完成 pragma 与结构初始化。
func Open(cfg config.Config) (*Store, error) {
	if dir := filepath.Dir(cfg.DBPath); dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("创建数据库目录失败: %w", err)
		}
	}

	db, err := sql.Open("sqlite", buildDSN(cfg))
	if err != nil {
		return nil, fmt.Errorf("打开数据库失败: %w", err)
	}

	// WAL 下读多写一：读连接可以并发，写连接由 busy_timeout + immediate 事务串行化。
	db.SetMaxOpenConns(8)
	db.SetMaxIdleConns(8)
	db.SetConnMaxLifetime(0)

	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("连接数据库失败: %w", err)
	}

	store := &Store{db: db, cfg: cfg}
	if err := store.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return store, nil
}

// buildDSN 把 pragma 写进 DSN，保证连接池里每条连接都带上。
// 参数取值与 db.js 的调优结论一致：mmap 提升全表扫描，cache_size 提升深翻页与批量写。
func buildDSN(cfg config.Config) string {
	pragmas := []string{
		"journal_mode(WAL)",
		fmt.Sprintf("cache_size(-%d)", intEnv("SQLITE_CACHE_MB", 128)*1024),
		fmt.Sprintf("mmap_size(%d)", intEnv("SQLITE_MMAP_MB", 256)*1024*1024),
		"synchronous(" + stringEnv("SQLITE_SYNCHRONOUS", "FULL") + ")",
		fmt.Sprintf("journal_size_limit(%d)", intEnv("SQLITE_JOURNAL_LIMIT_MB", 64)*1024*1024),
		"temp_store(MEMORY)",
		"busy_timeout(10000)",
	}

	params := url.Values{}
	for _, pragma := range pragmas {
		params.Add("_pragma", pragma)
	}
	// 写事务直接拿写锁，避免「先读后写」时把共享锁升级成排他锁而死等。
	params.Set("_txlock", "immediate")

	return "file:" + cfg.DBPath + "?" + params.Encode()
}

func intEnv(key string, fallback int) int {
	raw, ok := os.LookupEnv(key)
	if !ok {
		return fallback
	}
	parsed, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

func stringEnv(key, fallback string) string {
	if raw, ok := os.LookupEnv(key); ok && strings.TrimSpace(raw) != "" {
		return strings.ToUpper(strings.TrimSpace(raw))
	}
	return fallback
}

// DB 暴露底层连接，供少量特殊查询使用。
func (s *Store) DB() *sql.DB { return s.db }

// Close 关闭连接。
func (s *Store) Close() error { return s.db.Close() }

// Now 返回与 SQLite CURRENT_TIMESTAMP 同格式的 UTC 时间串。
func Now() string { return time.Now().UTC().Format("2006-01-02 15:04:05") }

const schemaSQL = `
CREATE TABLE IF NOT EXISTS accounts (
  email TEXT PRIMARY KEY,
  password TEXT DEFAULT '',
  client_id TEXT DEFAULT '',
  refresh_token TEXT DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS account_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  tags TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS email_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  message_id TEXT NOT NULL,
  subject TEXT,
  sender TEXT,
  received_date TEXT,
  body_preview TEXT,
  body_content TEXT,
  body_type TEXT DEFAULT 'text',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(email, message_id)
);
CREATE TABLE IF NOT EXISTS system_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS redeem_email_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  field_schema TEXT NOT NULL,
  mail_protocol TEXT NOT NULL DEFAULT 'imap',
  mail_protocols TEXT NOT NULL DEFAULT '["imap"]',
  import_delimiter TEXT NOT NULL DEFAULT '----',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS redeem_inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type_id INTEGER NOT NULL,
  serialized_value TEXT NOT NULL,
  search_text TEXT GENERATED ALWAYS AS (lower(serialized_value)) STORED,
  status TEXT NOT NULL DEFAULT 'available',
  pickup_protocols TEXT NOT NULL DEFAULT '["imap"]',
  pickup_imap INTEGER NOT NULL DEFAULT 0,
  pickup_graph INTEGER NOT NULL DEFAULT 0,
  redeemed_code_id INTEGER,
  redeemed_at TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(type_id, serialized_value)
);
CREATE TABLE IF NOT EXISTS redeem_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  normalized_code TEXT NOT NULL UNIQUE,
  type_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  redeemed_quantity INTEGER NOT NULL DEFAULT 0,
  note TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'unused',
  expires_at TEXT,
  redeemed_inventory_id INTEGER,
  redeemed_at TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS redeem_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_id INTEGER NOT NULL,
  inventory_id INTEGER NOT NULL,
  payload_raw TEXT,
  requester_ip TEXT DEFAULT '',
  requester_user_agent TEXT DEFAULT '',
  redeemed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email);
CREATE INDEX IF NOT EXISTS idx_account_tags_email ON account_tags(email);
CREATE INDEX IF NOT EXISTS idx_email_cache_email ON email_cache(email);
CREATE INDEX IF NOT EXISTS idx_redeem_types_active ON redeem_email_types(is_active);
CREATE INDEX IF NOT EXISTS idx_redeem_codes_normalized_code ON redeem_codes(normalized_code);
`

const indexSQL = `
CREATE INDEX IF NOT EXISTS idx_redeem_inventory_type_status_id
  ON redeem_inventory(type_id, status, id);
CREATE INDEX IF NOT EXISTS idx_redeem_inventory_type_id
  ON redeem_inventory(type_id, id);
CREATE INDEX IF NOT EXISTS idx_redeem_inventory_status_id
  ON redeem_inventory(status, id);
CREATE INDEX IF NOT EXISTS idx_redeem_inventory_imap_id
  ON redeem_inventory(pickup_imap, id);
CREATE INDEX IF NOT EXISTS idx_redeem_inventory_graph_id
  ON redeem_inventory(pickup_graph, id);
CREATE INDEX IF NOT EXISTS idx_redeem_inventory_type_status_imap_id
  ON redeem_inventory(type_id, status, pickup_imap, id);
CREATE INDEX IF NOT EXISTS idx_redeem_inventory_type_status_graph_id
  ON redeem_inventory(type_id, status, pickup_graph, id);
CREATE INDEX IF NOT EXISTS idx_redeem_codes_status_id
  ON redeem_codes(status, id);
CREATE INDEX IF NOT EXISTS idx_redeem_codes_type_status_id
  ON redeem_codes(type_id, status, id);
CREATE INDEX IF NOT EXISTS idx_redeem_records_code_id_id
  ON redeem_records(code_id, id);
`

const dropObsoleteIndexSQL = `
DROP INDEX IF EXISTS idx_redeem_inventory_type_status;
DROP INDEX IF EXISTS idx_redeem_codes_type_status;
DROP INDEX IF EXISTS idx_redeem_records_type_id;
DROP INDEX IF EXISTS idx_redeem_records_code_id;
DROP INDEX IF EXISTS idx_redeem_records_type_code_id;
`

const ftsSQL = `
DROP INDEX IF EXISTS idx_redeem_inventory_search;
CREATE VIRTUAL TABLE IF NOT EXISTS redeem_inventory_fts USING fts5(
  search_text,
  content = 'redeem_inventory',
  content_rowid = 'id',
  tokenize = 'trigram',
  detail = 'none',
  columnsize = 0
);
CREATE TRIGGER IF NOT EXISTS redeem_inventory_fts_insert
AFTER INSERT ON redeem_inventory BEGIN
  INSERT INTO redeem_inventory_fts(rowid, search_text)
  VALUES (new.id, new.search_text);
END;
CREATE TRIGGER IF NOT EXISTS redeem_inventory_fts_delete
AFTER DELETE ON redeem_inventory BEGIN
  INSERT INTO redeem_inventory_fts(redeem_inventory_fts, rowid, search_text)
  VALUES ('delete', old.id, old.search_text);
END;
CREATE TRIGGER IF NOT EXISTS redeem_inventory_fts_update
AFTER UPDATE OF serialized_value ON redeem_inventory BEGIN
  INSERT INTO redeem_inventory_fts(redeem_inventory_fts, rowid, search_text)
  VALUES ('delete', old.id, old.search_text);
  INSERT INTO redeem_inventory_fts(rowid, search_text)
  VALUES (new.id, new.search_text);
END;
`

const protocolFlagTriggerSQL = `
CREATE TRIGGER IF NOT EXISTS redeem_inventory_protocol_flags_insert
AFTER INSERT ON redeem_inventory
WHEN
  NEW.pickup_imap <> (instr(NEW.pickup_protocols, '"imap"') > 0)
  OR NEW.pickup_graph <> (instr(NEW.pickup_protocols, '"graph"') > 0)
BEGIN
  UPDATE redeem_inventory
  SET
    pickup_imap = (instr(NEW.pickup_protocols, '"imap"') > 0),
    pickup_graph = (instr(NEW.pickup_protocols, '"graph"') > 0)
  WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS redeem_inventory_protocol_flags_update
AFTER UPDATE OF pickup_protocols ON redeem_inventory
WHEN
  NEW.pickup_imap <> (instr(NEW.pickup_protocols, '"imap"') > 0)
  OR NEW.pickup_graph <> (instr(NEW.pickup_protocols, '"graph"') > 0)
BEGIN
  UPDATE redeem_inventory
  SET
    pickup_imap = (instr(NEW.pickup_protocols, '"imap"') > 0),
    pickup_graph = (instr(NEW.pickup_protocols, '"graph"') > 0)
  WHERE id = NEW.id;
END;
`

// migrate 与 db.js 的启动流程同序：建表 → 结构迁移 → FTS → 补列 → 索引 → 触发器。
func (s *Store) migrate() error {
	if _, err := s.db.Exec(schemaSQL); err != nil {
		return fmt.Errorf("建表失败: %w", err)
	}
	if err := s.migrateInventory(); err != nil {
		return err
	}
	if err := s.migrateRecords(); err != nil {
		return err
	}

	ftsExists, err := s.tableExists("redeem_inventory_fts")
	if err != nil {
		return err
	}
	if _, err := s.db.Exec(ftsSQL); err != nil {
		return fmt.Errorf("创建 FTS 表失败: %w", err)
	}
	if !ftsExists {
		if _, err := s.db.Exec(`INSERT INTO redeem_inventory_fts(redeem_inventory_fts) VALUES ('rebuild')`); err != nil {
			return fmt.Errorf("重建 FTS 索引失败: %w", err)
		}
	}

	columns := []struct{ table, column, definition string }{
		{"redeem_codes", "quantity", "INTEGER NOT NULL DEFAULT 1"},
		{"redeem_codes", "redeemed_quantity", "INTEGER NOT NULL DEFAULT 0"},
		{"redeem_codes", "redeemed_inventory_id", "INTEGER"},
		{"redeem_codes", "redeemed_at", "TEXT"},
		{"redeem_codes", "data_deleted_at", "TEXT"},
		{"redeem_codes", "data_deleted_reason", "TEXT DEFAULT ''"},
		{"redeem_inventory", "pickup_protocols", `TEXT NOT NULL DEFAULT '["imap"]'`},
		{"redeem_inventory", "pickup_imap", "INTEGER NOT NULL DEFAULT 0"},
		{"redeem_inventory", "pickup_graph", "INTEGER NOT NULL DEFAULT 0"},
	}
	addedFlagColumn := false
	for _, item := range columns {
		added, err := s.ensureColumn(item.table, item.column, item.definition)
		if err != nil {
			return err
		}
		if added && (item.column == "pickup_imap" || item.column == "pickup_graph") {
			addedFlagColumn = true
		}
	}

	// 标志列是后加的：第一次补列时按 pickup_protocols 回填，老数据没有 JSON 时
	// 退回类型默认协议，避免协议筛选静默查不到数据。
	if addedFlagColumn {
		if _, err := s.db.Exec(backfillProtocolFlagsSQL); err != nil {
			return fmt.Errorf("回填协议标志失败: %w", err)
		}
	}

	if _, err := s.db.Exec(indexSQL); err != nil {
		return fmt.Errorf("创建索引失败: %w", err)
	}
	if _, err := s.db.Exec(dropObsoleteIndexSQL); err != nil {
		return fmt.Errorf("清理旧索引失败: %w", err)
	}
	if _, err := s.db.Exec(protocolFlagTriggerSQL); err != nil {
		return fmt.Errorf("创建协议标志触发器失败: %w", err)
	}
	return nil
}

const backfillProtocolFlagsSQL = `
UPDATE redeem_inventory
SET
  pickup_imap = CASE
    WHEN json_valid(pickup_protocols) THEN
      CASE WHEN EXISTS (
        SELECT 1 FROM json_each(redeem_inventory.pickup_protocols) WHERE value = 'imap'
      ) THEN 1 ELSE 0 END
    ELSE
      CASE WHEN (
        SELECT mail_protocol FROM redeem_email_types WHERE id = redeem_inventory.type_id
      ) = 'imap' THEN 1 ELSE 0 END
  END,
  pickup_graph = CASE
    WHEN json_valid(pickup_protocols) THEN
      CASE WHEN EXISTS (
        SELECT 1 FROM json_each(redeem_inventory.pickup_protocols) WHERE value = 'graph'
      ) THEN 1 ELSE 0 END
    ELSE
      CASE WHEN (
        SELECT mail_protocol FROM redeem_email_types WHERE id = redeem_inventory.type_id
      ) = 'graph' THEN 1 ELSE 0 END
  END
`

// migrateInventory 去掉 redeem_inventory.payload_json，search_text 改为生成列。
func (s *Store) migrateInventory() error {
	columns, err := s.tableColumns("redeem_inventory")
	if err != nil {
		return err
	}
	if !contains(columns, "payload_json") {
		return nil
	}

	existing := toSet(columns)
	copyColumns := []string{
		"id", "type_id", "serialized_value", "status", "pickup_protocols",
		"pickup_imap", "pickup_graph", "redeemed_code_id", "redeemed_at",
		"created_at", "updated_at",
	}
	selectList := make([]string, 0, len(copyColumns))
	for _, name := range copyColumns {
		switch {
		case existing[name]:
			selectList = append(selectList, name)
		case name == "pickup_imap" || name == "pickup_graph":
			selectList = append(selectList, "0")
		case name == "pickup_protocols":
			selectList = append(selectList, `'["imap"]'`)
		default:
			selectList = append(selectList, "NULL")
		}
	}

	statement := fmt.Sprintf(`
DROP TRIGGER IF EXISTS redeem_inventory_fts_insert;
DROP TRIGGER IF EXISTS redeem_inventory_fts_delete;
DROP TRIGGER IF EXISTS redeem_inventory_fts_update;
DROP TABLE IF EXISTS redeem_inventory_fts;
DROP TABLE IF EXISTS redeem_inventory_v2;
CREATE TABLE redeem_inventory_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type_id INTEGER NOT NULL,
  serialized_value TEXT NOT NULL,
  search_text TEXT GENERATED ALWAYS AS (lower(serialized_value)) STORED,
  status TEXT NOT NULL DEFAULT 'available',
  pickup_protocols TEXT NOT NULL DEFAULT '["imap"]',
  pickup_imap INTEGER NOT NULL DEFAULT 0,
  pickup_graph INTEGER NOT NULL DEFAULT 0,
  redeemed_code_id INTEGER,
  redeemed_at TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(type_id, serialized_value)
);
INSERT INTO redeem_inventory_v2 (%s) SELECT %s FROM redeem_inventory;
DROP TABLE redeem_inventory;
ALTER TABLE redeem_inventory_v2 RENAME TO redeem_inventory;
`, strings.Join(copyColumns, ", "), strings.Join(selectList, ", "))

	return s.inTx(func(tx *sql.Tx) error {
		_, err := tx.Exec(statement)
		return err
	})
}

// migrateRecords 去掉 redeem_records 的副本列，只留关联。
// payload_raw 仅给「库存行已被物理删除」的孤儿记录兜底。
func (s *Store) migrateRecords() error {
	columns, err := s.tableColumns("redeem_records")
	if err != nil {
		return err
	}
	if !contains(columns, "payload_json") {
		return nil
	}

	existing := toSet(columns)
	hasInventory, err := s.tableExists("redeem_inventory")
	if err != nil {
		return err
	}

	inventoryLookup := ""
	inventoryMissing := "1"
	if hasInventory {
		inventoryLookup = "LEFT JOIN redeem_inventory inv ON inv.id = records.inventory_id"
		inventoryMissing = "inv.id IS NULL"
	}

	pick := func(name, fallback string) string {
		if existing[name] {
			return "records." + name
		}
		return fallback
	}

	statement := fmt.Sprintf(`
DROP TABLE IF EXISTS redeem_records_v2;
CREATE TABLE redeem_records_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_id INTEGER NOT NULL,
  inventory_id INTEGER NOT NULL,
  payload_raw TEXT,
  requester_ip TEXT DEFAULT '',
  requester_user_agent TEXT DEFAULT '',
  redeemed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO redeem_records_v2 (
  id, code_id, inventory_id, payload_raw,
  requester_ip, requester_user_agent, redeemed_at
)
SELECT
  records.id,
  records.code_id,
  records.inventory_id,
  CASE WHEN %s THEN
    CASE
      WHEN json_valid(records.payload_json)
        THEN COALESCE(json_extract(records.payload_json, '$.raw_line'), records.payload_json)
      ELSE records.payload_json
    END
  ELSE NULL END,
  %s,
  %s,
  %s
FROM redeem_records records
%s;
DROP TABLE redeem_records;
ALTER TABLE redeem_records_v2 RENAME TO redeem_records;
`, inventoryMissing,
		pick("requester_ip", "''"),
		pick("requester_user_agent", "''"),
		pick("redeemed_at", "CURRENT_TIMESTAMP"),
		inventoryLookup)

	return s.inTx(func(tx *sql.Tx) error {
		_, err := tx.Exec(statement)
		return err
	})
}

// ensureColumn 补列并返回「是否真的新增了」。
func (s *Store) ensureColumn(table, column, definition string) (bool, error) {
	columns, err := s.tableColumns(table)
	if err != nil {
		return false, err
	}
	if contains(columns, column) {
		return false, nil
	}
	if _, err := s.db.Exec(fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s", table, column, definition)); err != nil {
		return false, err
	}
	return true, nil
}

func (s *Store) tableColumns(table string) ([]string, error) {
	rows, err := s.db.Query(fmt.Sprintf("SELECT name FROM pragma_table_info('%s')", table))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var columns []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		columns = append(columns, name)
	}
	return columns, rows.Err()
}

func (s *Store) tableExists(name string) (bool, error) {
	var count int
	err := s.db.QueryRow(
		"SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?", name,
	).Scan(&count)
	if err != nil {
		return false, err
	}
	return count > 0, nil
}

// inTx 执行写事务。
func (s *Store) inTx(fn func(tx *sql.Tx) error) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		tx.Rollback()
		return err
	}
	return tx.Commit()
}

func contains(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}

func toSet(list []string) map[string]bool {
	set := make(map[string]bool, len(list))
	for _, item := range list {
		set[item] = true
	}
	return set
}

// NullString 把可空列读成空串。
func NullString(value sql.NullString) string {
	if value.Valid {
		return value.String
	}
	return ""
}
