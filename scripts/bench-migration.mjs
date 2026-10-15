// 模拟「旧库升级」：用旧 schema 造 13w 行，再计时 db.js 的启动迁移耗时。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";

const dir = path.join(os.tmpdir(), "redeem-olddb");
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const dbPath = path.join(dir, "old.db");

const raw = new Database(dbPath);
raw.pragma("journal_mode = WAL");
raw.exec(`
CREATE TABLE redeem_email_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  description TEXT DEFAULT '', field_schema TEXT NOT NULL,
  mail_protocol TEXT NOT NULL DEFAULT 'imap', mail_protocols TEXT NOT NULL DEFAULT '["imap"]',
  import_delimiter TEXT NOT NULL DEFAULT '----', is_active INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE redeem_inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT, type_id INTEGER NOT NULL, payload_json TEXT NOT NULL,
  serialized_value TEXT NOT NULL, search_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'available', pickup_protocols TEXT NOT NULL DEFAULT '["imap"]',
  redeemed_code_id INTEGER, redeemed_at TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(type_id, serialized_value)
);
CREATE TABLE redeem_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, normalized_code TEXT NOT NULL UNIQUE,
  type_id INTEGER NOT NULL, quantity INTEGER NOT NULL DEFAULT 1, redeemed_quantity INTEGER NOT NULL DEFAULT 0,
  note TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'unused', expires_at TEXT,
  redeemed_inventory_id INTEGER, redeemed_at TEXT, data_deleted_at TEXT, data_deleted_reason TEXT DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE redeem_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT, code_id INTEGER NOT NULL, inventory_id INTEGER NOT NULL,
  type_id INTEGER NOT NULL, code TEXT NOT NULL, normalized_code TEXT NOT NULL, payload_json TEXT NOT NULL,
  requester_ip TEXT DEFAULT '', requester_user_agent TEXT DEFAULT '',
  redeemed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE system_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX idx_redeem_inventory_type_status ON redeem_inventory(type_id, status);
CREATE INDEX idx_redeem_codes_type_status ON redeem_codes(type_id, status);
CREATE INDEX idx_redeem_records_type_id ON redeem_records(type_id);
CREATE INDEX idx_redeem_records_code_id ON redeem_records(code_id);
`);

raw.prepare(
  `INSERT INTO redeem_email_types (slug, name, description, field_schema, mail_protocol, mail_protocols, import_delimiter, is_active)
   VALUES ('t','T','','[]','imap','["imap","graph"]','----',1)`,
).run();

const insertInv = raw.prepare(
  `INSERT INTO redeem_inventory (type_id, payload_json, serialized_value, search_text, status, pickup_protocols)
   VALUES (1, ?, ?, ?, ?, ?)`,
);
const t0 = Date.now();
raw.exec("BEGIN");
for (let i = 1; i <= 130000; i += 1) {
  const email = `user${i}@outlook.com`;
  const serialized = `${email}----pw-${i}----client----rt-${i}`;
  const roll = i % 100;
  const status = roll < 80 ? "available" : roll < 95 ? "redeemed" : "unavailable";
  const protocols = i % 3 === 0 ? '["graph"]' : i % 3 === 1 ? '["imap"]' : '["imap","graph"]';
  insertInv.run(
    JSON.stringify({ account: email, password: `pw-${i}`, refreshtoken: `rt-${i}` }),
    serialized,
    serialized.toLowerCase(),
    status,
    protocols,
  );
}
raw.exec("COMMIT");
console.log(`旧库造数完成: 130000 行，用时 ${Date.now() - t0}ms`);
raw.close();

const migrateStart = Date.now();
process.env.DB_PATH = dbPath;
await import("../src/db.js");
console.log(`启动迁移（加列 + 回填 + 建索引）总耗时: ${Date.now() - migrateStart}ms`);

const verify = new Database(dbPath, { readonly: true });
const counts = verify.prepare("SELECT COUNT(*) AS c FROM redeem_inventory WHERE pickup_imap = 1").get();
console.log("回填后 pickup_imap=1 行数:", counts.c);
verify.close();
process.exit(0);
