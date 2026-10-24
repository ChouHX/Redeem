import Database from "better-sqlite3";
import { DB_PATH, CLIENT_ID, DEFAULT_EMAIL_LIMIT, REDEEM_ACCESS_TTL_MS } from "./config.js";
import {
  DEFAULT_REDEEM_EMAIL_TYPE,
  generateRedeemCode,
  normalizeRedeemCode,
  normalizeMailProtocol,
  normalizeMailProtocols,
  parseMailboxAccountLine,
  parseRedeemFieldSchema,
  serializeInventoryPayload,
} from "./redeem.js";

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// 以下参数默认值对 10w 行级库明显偏小，实测（13.5w 行 / 573MB）：
//   mmap_size      : 全表扫描 164ms→71ms，深翻页 57ms→1.4ms
//   cache_size     : 深翻页 57ms→2.4ms，批量写 286ms→125ms
//   journal_size_limit: 否则 -wal 会一直涨（线上曾到 252MB）
// synchronous 默认保持 FULL：改 NORMAL 写更快，但断电可能丢最后若干已提交事务，
// 对发卡场景是资损风险，需要时用 SQLITE_SYNCHRONOUS=NORMAL 显式开启。
const SQLITE_CACHE_MB = Number(process.env.SQLITE_CACHE_MB || 128);
const SQLITE_MMAP_MB = Number(process.env.SQLITE_MMAP_MB || 256);
const SQLITE_SYNCHRONOUS = String(process.env.SQLITE_SYNCHRONOUS || "FULL").toUpperCase();
const SQLITE_JOURNAL_LIMIT_MB = Number(process.env.SQLITE_JOURNAL_LIMIT_MB || 64);

if (Number.isFinite(SQLITE_CACHE_MB) && SQLITE_CACHE_MB > 0) {
  db.pragma(`cache_size = -${Math.round(SQLITE_CACHE_MB * 1024)}`);
}
if (Number.isFinite(SQLITE_MMAP_MB) && SQLITE_MMAP_MB > 0) {
  db.pragma(`mmap_size = ${Math.round(SQLITE_MMAP_MB * 1024 * 1024)}`);
}
if (["FULL", "NORMAL", "OFF"].includes(SQLITE_SYNCHRONOUS)) {
  db.pragma(`synchronous = ${SQLITE_SYNCHRONOUS}`);
}
if (Number.isFinite(SQLITE_JOURNAL_LIMIT_MB) && SQLITE_JOURNAL_LIMIT_MB > 0) {
  db.pragma(`journal_size_limit = ${Math.round(SQLITE_JOURNAL_LIMIT_MB * 1024 * 1024)}`);
}
db.pragma("temp_store = MEMORY");

const shouldSeedDefaultRedeemType = !db
  .prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'redeem_email_types' LIMIT 1",
  )
  .get();

db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  email TEXT PRIMARY KEY,
  password TEXT DEFAULT '',
  client_id TEXT DEFAULT '',
  refresh_token TEXT NOT NULL,
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
-- 兑换记录只保留「谁、什么时候、领了哪条库存」这三件事。
-- 账号内容、类型、卡密号全部通过 inventory_id / code_id 关联读取，不存副本：
-- 实测 6.96w 条记录里 payload_json 与 inventory.serialized_value 逐字节相等
-- （3.9w 条 100% 一致），code/normalized_code/type_id 也与 redeem_codes 100% 相等。
-- payload_raw 仅作兜底：历史上有 1000 条记录对应的库存行已被物理删除，
-- 这些孤儿记录没有可关联对象，只有这一列能还原当时发的账号。
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
`);

// --- 迁移：redeem_inventory 去掉 payload_json，search_text 改为生成列 ---
// 旧结构把同一串数据存了三份（payload_json / serialized_value / search_text）。
// 实测 13.5w 行：三列共 218MB，而真实信息只有 72MB；且 serialized_value 与
// payload_json.raw_line、search_text 与 lower(serialized_value) 100% 相等。
// payload 改为读取时按 { raw_line } 重建（比 JSON.parse 更快）。
//
// search_text 用 STORED 而非 VIRTUAL：两者都省掉冗余写入，但实测
//   VIRTUAL 会让 FTS 全表扫描从 75ms 涨到 106ms（每行现算 lower()），
//   STORED  则降到 71ms，文件仍是 466MB（原 573MB）。取 STORED。
{
  const inventoryColumns = db
    .prepare("SELECT name FROM pragma_table_info('redeem_inventory')")
    .all()
    .map((column) => column.name);

  if (inventoryColumns.includes("payload_json")) {
    const existing = new Set(inventoryColumns);
    const copyColumns = [
      "id",
      "type_id",
      "serialized_value",
      "status",
      "pickup_protocols",
      "pickup_imap",
      "pickup_graph",
      "redeemed_code_id",
      "redeemed_at",
      "created_at",
      "updated_at",
    ];
    const selectList = copyColumns
      .map((name) => {
        if (existing.has(name)) return name;
        if (name === "pickup_imap" || name === "pickup_graph") return "0";
        if (name === "pickup_protocols") return `'["imap"]'`;
        return "NULL";
      })
      .join(", ");

    db.transaction(() => {
      db.exec(`
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
        INSERT INTO redeem_inventory_v2 (${copyColumns.join(", ")})
          SELECT ${selectList} FROM redeem_inventory;
        DROP TABLE redeem_inventory;
        ALTER TABLE redeem_inventory_v2 RENAME TO redeem_inventory;
      `);
    })();
  }
}

// --- 迁移：redeem_records 去掉副本列，只留关联 ---
// 旧结构每条记录都复制了一份账号内容（payload_json）、卡密码（code /
// normalized_code）和类型（type_id），和 redeem_inventory / redeem_codes 完全重复。
// 实测 6.96w 条：payload_json 38.94MB、code+normalized_code 1.86MB、type_id 0.07MB，
// 而记录表总行字节只有 52.81MB —— 冗余占 77%。
//
// 迁移后读取改为 COALESCE(inventory.serialized_value, records.payload_raw)：
//   · 库存行在 → 拿库存的最新值（这也顺带修掉了 refresh_token 轮换后
//     记录里仍是旧令牌、24h 内重新打开兑换页会登录失败的问题）；
//   · 库存行已被物理删除（线上有 1000 条这种孤儿记录）→ 退回 payload_raw 快照。
{
  const recordColumns = db
    .prepare("SELECT name FROM pragma_table_info('redeem_records')")
    .all()
    .map((column) => column.name);

  if (recordColumns.includes("payload_json")) {
    const existing = new Set(recordColumns);
    const hasInventory = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'redeem_inventory' LIMIT 1",
      )
      .get();
    // 库存行是否还在，决定这条记录需不需要留快照。
    const inventoryLookup = hasInventory
      ? "LEFT JOIN redeem_inventory inv ON inv.id = records.inventory_id"
      : "";
    const inventoryMissing = hasInventory ? "inv.id IS NULL" : "1";
    const payloadSource = existing.has("payload_json") ? "records.payload_json" : "NULL";

    db.transaction(() => {
      db.exec(`
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
          CASE WHEN ${inventoryMissing} THEN
            CASE
              WHEN json_valid(${payloadSource})
                THEN COALESCE(json_extract(${payloadSource}, '$.raw_line'), ${payloadSource})
              ELSE ${payloadSource}
            END
          ELSE NULL END,
          ${existing.has("requester_ip") ? "records.requester_ip" : "''"},
          ${existing.has("requester_user_agent") ? "records.requester_user_agent" : "''"},
          ${existing.has("redeemed_at") ? "records.redeemed_at" : "CURRENT_TIMESTAMP"}
        FROM redeem_records records
        ${inventoryLookup};
        DROP TABLE redeem_records;
        ALTER TABLE redeem_records_v2 RENAME TO redeem_records;
      `);
    })();
  }
}



const shouldRebuildInventorySearch = !db
  .prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'redeem_inventory_fts' LIMIT 1",
  )
  .get();

db.exec(`
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
-- search_text 是生成列，只能随 serialized_value 变化而变化，
-- 因此同步触发器必须挂在 serialized_value 上（挂 search_text 永远不会触发）。
CREATE TRIGGER IF NOT EXISTS redeem_inventory_fts_update
AFTER UPDATE OF serialized_value ON redeem_inventory BEGIN
  INSERT INTO redeem_inventory_fts(redeem_inventory_fts, rowid, search_text)
  VALUES ('delete', old.id, old.search_text);
  INSERT INTO redeem_inventory_fts(rowid, search_text)
  VALUES (new.id, new.search_text);
END;
`);

if (shouldRebuildInventorySearch) {
  db.prepare(
    "INSERT INTO redeem_inventory_fts(redeem_inventory_fts) VALUES ('rebuild')",
  ).run();
}

function ensureColumn(tableName, columnName, columnDefinition) {
  const exists = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .some((column) => column.name === columnName);

  if (!exists) {
    db.exec(
      `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`,
    );
  }
  return !exists;
}

ensureColumn("redeem_codes", "quantity", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("redeem_codes", "redeemed_quantity", "INTEGER NOT NULL DEFAULT 0");
ensureColumn(
  "redeem_email_types",
  "mail_protocol",
  "TEXT NOT NULL DEFAULT 'imap'",
);
const addedTypeProtocols = ensureColumn(
  "redeem_email_types",
  "mail_protocols",
  "TEXT NOT NULL DEFAULT '[\"imap\"]'",
);
const addedInventoryProtocols = ensureColumn(
  "redeem_inventory",
  "pickup_protocols",
  "TEXT NOT NULL DEFAULT '[\"imap\"]'",
);

if (addedTypeProtocols) {
  db.prepare(
    "UPDATE redeem_email_types SET mail_protocols = json_array(mail_protocol)",
  ).run();
}
if (addedInventoryProtocols) {
  db.prepare(
    `UPDATE redeem_inventory SET pickup_protocols = json_array((SELECT mail_protocol FROM redeem_email_types WHERE id = redeem_inventory.type_id))`,
  ).run();
}
ensureColumn("redeem_codes", "data_deleted_at", "TEXT");
ensureColumn("redeem_codes", "data_deleted_reason", "TEXT DEFAULT ''");

// 取件协议标志列：把 pickup_protocols 的 JSON 判断物化成整数列，
// 让协议筛选 / 统计走索引，避免每次查询都对 13w 行做 json_each 全表扫描。
const addedInventoryImapFlag = ensureColumn(
  "redeem_inventory",
  "pickup_imap",
  "INTEGER NOT NULL DEFAULT 0",
);
const addedInventoryGraphFlag = ensureColumn(
  "redeem_inventory",
  "pickup_graph",
  "INTEGER NOT NULL DEFAULT 0",
);

if (addedInventoryImapFlag || addedInventoryGraphFlag) {
  db.prepare(
    `
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
    `,
  ).run();
}

// 覆盖索引：尾部带上 id，使「筛选 + ORDER BY id DESC + LIMIT」无需临时排序。
db.exec(`
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
`);

// 清理被新索引前缀覆盖的旧索引，减少每次写入的索引维护开销。
// (type_id, status) 被 (type_id, status, id) 覆盖；records 的两个单列索引同理。
db.exec(`
DROP INDEX IF EXISTS idx_redeem_inventory_type_status;
DROP INDEX IF EXISTS idx_redeem_codes_type_status;
DROP INDEX IF EXISTS idx_redeem_records_type_id;
DROP INDEX IF EXISTS idx_redeem_records_code_id;
-- 记录表不再冗余 type_id，按类型筛选改走 redeem_codes.type_id，这个索引失去前缀。
DROP INDEX IF EXISTS idx_redeem_records_type_code_id;
`);

// 标志列兜底：pickup_imap / pickup_graph 必须与 pickup_protocols 一致。
// WHEN 守卫保证「写入方已算好标志列」时不触发额外 UPDATE，因此正常路径零开销；
// 一旦有别的写入路径漏填，触发器会自动纠正，避免协议筛选静默查不到数据。
db.exec(`
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
`);

function rowToAccount(row) {
  return {
    password: row.password || "",
    client_id: row.client_id || "",
    refresh_token: row.refresh_token || "",
  };
}

function clampPositiveInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback;
  }

  return Math.min(parsed, max);
}

// 由 pickup_protocols 推导物化标志列，供所有写入路径复用。
function protocolFlags(protocols) {
  const list = normalizeMailProtocols(protocols, []);
  return {
    pickup_imap: list.includes("imap") ? 1 : 0,
    pickup_graph: list.includes("graph") ? 1 : 0,
  };
}

// 批量操作分块大小：兼顾 SQLite 变量上限与语句开销。
const SQL_CHUNK_SIZE = 400;
const sqlStatementCache = new Map();

function chunkArray(items, size = SQL_CHUNK_SIZE) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function placeholders(count) {
  return new Array(count).fill("?").join(", ");
}

// 按 SQL 文本缓存 prepared statement，避免在分块循环里反复编译同一条语句。
function prepareCached(sql) {
  let statement = sqlStatementCache.get(sql);
  if (!statement) {
    statement = db.prepare(sql);
    sqlStatementCache.set(sql, statement);
  }
  return statement;
}

function normalizeIdTargets(ids) {
  return [
    ...new Set(
      (ids || [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0),
    ),
  ];
}

function buildRedeemTypeSelect() {
  return `
    SELECT
      t.*,
      (
        SELECT COUNT(*)
        FROM redeem_inventory inventory
        WHERE inventory.type_id = t.id AND inventory.status = 'available'
      ) AS available_inventory_count,
      (
        SELECT COUNT(*)
        FROM redeem_inventory inventory
        WHERE
          inventory.type_id = t.id
          AND inventory.status = 'available'
          AND inventory.pickup_imap = 1
      ) AS available_imap_inventory_count,
      (
        SELECT COUNT(*)
        FROM redeem_inventory inventory
        WHERE
          inventory.type_id = t.id
          AND inventory.status = 'available'
          AND inventory.pickup_graph = 1
      ) AS available_graph_inventory_count,
      (
        SELECT COUNT(*)
        FROM redeem_codes codes
        WHERE
          codes.type_id = t.id
          AND codes.status = 'unused'
          AND (codes.expires_at IS NULL OR codes.expires_at > CURRENT_TIMESTAMP)
      ) AS available_code_count,
      (
        SELECT COUNT(*)
        FROM redeem_codes codes
        JOIN redeem_records records ON records.code_id = codes.id
        WHERE codes.type_id = t.id
      ) AS redeemed_count
    FROM redeem_email_types t
  `;
}

function rowToRedeemType(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description || "",
    field_schema: parseRedeemFieldSchema(row.field_schema),
    mail_protocols: normalizeMailProtocols(row.mail_protocols, [
      row.mail_protocol,
    ]),
    mail_protocol: normalizeMailProtocols(row.mail_protocols, [
      row.mail_protocol,
    ])[0],
    import_delimiter: row.import_delimiter || "----",
    is_active: Boolean(row.is_active),
    available_inventory_count: Number(row.available_inventory_count || 0),
    available_inventory_by_protocol: {
      imap: Number(row.available_imap_inventory_count || 0),
      graph: Number(row.available_graph_inventory_count || 0),
    },
    available_code_count: Number(row.available_code_count || 0),
    redeemed_count: Number(row.redeemed_count || 0),
    created_at: row.created_at || "",
    updated_at: row.updated_at || "",
  };
}

function rowToRedeemInventory(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    type_id: row.type_id,
    type_name: row.type_name || "",
    type_slug: row.type_slug || "",
    field_schema: row.field_schema
      ? parseRedeemFieldSchema(row.field_schema)
      : undefined,
    mail_protocols: normalizeMailProtocols(row.pickup_protocols, [
      row.mail_protocol,
    ]),
    mail_protocol: normalizeMailProtocols(row.pickup_protocols, [
      row.mail_protocol,
    ])[0],
    // 类型允许的协议范围，供结果序列化判定账号可用协议的上下限。
    type_mail_protocols: normalizeMailProtocols(row.type_mail_protocols, [
      row.mail_protocol,
    ]),
    import_delimiter: row.import_delimiter || "----",
    payload: { raw_line: row.serialized_value || "" },
    serialized_value: row.serialized_value || "",
    search_text: row.search_text || "",
    status: row.status,
    redeemed_code_id: row.redeemed_code_id ?? null,
    redeemed_at: row.redeemed_at || null,
    created_at: row.created_at || "",
    updated_at: row.updated_at || "",
  };
}

function normalizeLookupValue(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function extractMailboxCredentials(payload = {}) {
  if (payload.raw_line) {
    const parsed = parseMailboxAccountLine(payload.raw_line, CLIENT_ID);
    if (parsed?.email && parsed?.refresh_token) {
      return parsed;
    }
  }

  const email = String(
    payload.account || payload.email || payload.mail || payload.username || "",
  ).trim();
  const refreshToken = String(
    payload.refreshtoken || payload.refresh_token || "",
  ).trim();

  if (!email || !refreshToken) {
    return null;
  }

  return {
    email,
    password: String(payload.password || "").trim(),
    client_id:
      String(payload.oauth2id || payload.client_id || CLIENT_ID).trim() ||
      CLIENT_ID,
    refresh_token: refreshToken,
  };
}

function deriveRedeemCodeStatus(row) {
  if (!row) {
    return "";
  }

  if (
    row.status === "unused" &&
    row.expires_at &&
    Date.parse(row.expires_at) <= Date.now()
  ) {
    return "expired";
  }

  return row.status;
}

function normalizeCodeStatusFilter(status) {
  const nextStatus = String(status || "").trim();
  if (nextStatus === "available") {
    return {
      conditions: [
        "codes.status = 'unused'",
        "(codes.expires_at IS NULL OR codes.expires_at > CURRENT_TIMESTAMP)",
      ],
      params: [],
    };
  }

  if (nextStatus === "expired") {
    return {
      conditions: [
        "codes.status = 'unused'",
        "codes.expires_at IS NOT NULL",
        "codes.expires_at <= CURRENT_TIMESTAMP",
      ],
      params: [],
    };
  }

  if (
    nextStatus === "unused" ||
    nextStatus === "redeemed" ||
    nextStatus === "disabled"
  ) {
    return {
      conditions: ["codes.status = ?"],
      params: [nextStatus],
    };
  }

  return {
    conditions: [],
    params: [],
  };
}

function buildRedeemCodesWhere({
  type_id = "",
  status = "",
  q = "",
  min_quantity = "",
  max_quantity = "",
} = {}) {
  const conditions = [];
  const params = [];

  if (type_id) {
    conditions.push("codes.type_id = ?");
    params.push(Number(type_id));
  }

  const normalizedStatus = normalizeCodeStatusFilter(status);
  conditions.push(...normalizedStatus.conditions);
  params.push(...normalizedStatus.params);

  if (q) {
    conditions.push("codes.normalized_code LIKE ?");
    params.push(`%${normalizeRedeemCode(q)}%`);
  }

  const minQuantity = Number(min_quantity);
  if (Number.isInteger(minQuantity) && minQuantity > 0) {
    conditions.push("codes.quantity >= ?");
    params.push(minQuantity);
  }

  const maxQuantity = Number(max_quantity);
  if (Number.isInteger(maxQuantity) && maxQuantity > 0) {
    conditions.push("codes.quantity <= ?");
    params.push(maxQuantity);
  }

  return {
    where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

function buildRedeemInventoryWhere({
  type_id = "",
  status = "",
  protocol = "",
  q = "",
} = {}) {
  const conditions = [];
  const params = [];

  if (type_id) {
    conditions.push("inventory.type_id = ?");
    params.push(Number(type_id));
  }

  if (
    status === "available" ||
    status === "unavailable" ||
    status === "redeemed"
  ) {
    conditions.push("inventory.status = ?");
    params.push(status);
  }

  if (protocol === "imap" || protocol === "graph") {
    conditions.push(`inventory.pickup_${protocol} = 1`);
  }

  if (q) {
    const normalizedQuery = String(q).trim().toLowerCase();
    if (Array.from(normalizedQuery).length >= 3) {
      conditions.push(
        `inventory.id IN (
          SELECT rowid
          FROM redeem_inventory_fts
          WHERE search_text LIKE ?
        )`,
      );
    } else {
      conditions.push("inventory.search_text LIKE ?");
    }
    params.push(`%${normalizedQuery}%`);
  }

  return {
    where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

function rowToRedeemCode(row) {
  if (!row) {
    return null;
  }

  const quantity = Math.max(1, Number(row.quantity || 1));
  const redeemedQuantity = Math.max(0, Number(row.redeemed_quantity || 0));

  return {
    id: row.id,
    code: row.code,
    normalized_code: row.normalized_code,
    type_id: row.type_id,
    type_name: row.type_name || "",
    type_slug: row.type_slug || "",
    quantity,
    redeemed_quantity: redeemedQuantity,
    remaining_quantity: Math.max(0, quantity - redeemedQuantity),
    note: row.note || "",
    status: row.status,
    derived_status: deriveRedeemCodeStatus(row),
    expires_at: row.expires_at || null,
    redeemed_inventory_id: row.redeemed_inventory_id ?? null,
    redeemed_at: row.redeemed_at || null,
    data_deleted_at: row.data_deleted_at || null,
    data_deleted_reason: row.data_deleted_reason || "",
    created_at: row.created_at || "",
    updated_at: row.updated_at || "",
  };
}

function rowToRedeemRecord(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    code_id: row.code_id,
    inventory_id: row.inventory_id,
    type_id: row.type_id,
    code: row.code,
    normalized_code: row.normalized_code,
    type_name: row.type_name || "",
    type_slug: row.type_slug || "",
    type_description: row.type_description || "",
    field_schema: row.field_schema
      ? parseRedeemFieldSchema(row.field_schema)
      : undefined,
    mail_protocols: normalizeMailProtocols(row.pickup_protocols, [
      row.mail_protocol,
    ]),
    mail_protocol: normalizeMailProtocols(row.pickup_protocols, [
      row.mail_protocol,
    ])[0],
    // 类型允许的协议范围，供结果序列化判定账号可用协议的上下限。
    type_mail_protocols: normalizeMailProtocols(row.type_mail_protocols, [
      row.mail_protocol,
    ]),
    import_delimiter: row.import_delimiter || "----",
    // 记录不再存账号副本：优先用库存行当前值，孤儿记录才退回快照。
    payload: { raw_line: row.payload_raw || "" },
    requester_ip: row.requester_ip || "",
    requester_user_agent: row.requester_user_agent || "",
    redeemed_at: row.redeemed_at || "",
  };
}

function rowToRedeemRecordGroup(row) {
  if (!row) {
    return null;
  }

  return {
    code_id: row.code_id,
    type_id: row.type_id,
    code: row.code,
    normalized_code: row.normalized_code,
    type_name: row.type_name || "",
    type_slug: row.type_slug || "",
    mail_protocol: normalizeMailProtocol(row.mail_protocol),
    item_count: Number(row.item_count || 0),
    redeemed_at: row.redeemed_at || "",
    requester_ip: row.requester_ip || "",
    requester_user_agent: row.requester_user_agent || "",
  };
}

function nowTimestamp() {
  return db.prepare("SELECT CURRENT_TIMESTAMP AS now").get().now;
}

function rowToRedeemTypeFromCode(row) {
  return rowToRedeemType({
    id: row.type_id,
    slug: row.type_slug,
    name: row.type_name,
    description: row.description,
    field_schema: row.field_schema,
    mail_protocol: row.mail_protocol,
    // 漏掉这一列会让类型协议退化成单值默认协议，导致结果展示与账号能力不符。
    mail_protocols: row.mail_protocols,
    import_delimiter: row.import_delimiter,
    is_active: 1,
    available_inventory_count: 0,
    available_code_count: 0,
    redeemed_count: 0,
    created_at: "",
    updated_at: "",
  });
}

function recordToRedeemInventory(record, codeId) {
  return {
    id: record.inventory_id,
    type_id: record.type_id,
    type_name: record.type_name,
    type_slug: record.type_slug,
    field_schema: record.field_schema,
    // 已兑换后重新载入必须沿用账号自身的取件协议，否则会退化成类型默认协议。
    mail_protocols: normalizeMailProtocols(record.mail_protocols, [
      record.mail_protocol,
    ]),
    mail_protocol: normalizeMailProtocols(record.mail_protocols, [
      record.mail_protocol,
    ])[0],
    type_mail_protocols: normalizeMailProtocols(record.type_mail_protocols, [
      record.mail_protocol,
    ]),
    import_delimiter: record.import_delimiter,
    payload: record.payload,
    serialized_value: "",
    search_text: "",
    status: "redeemed",
    redeemed_code_id: codeId,
    redeemed_at: record.redeemed_at,
    created_at: "",
    updated_at: "",
  };
}

function buildExistingRedeemResult(codeRow) {
  const records = getRedeemRecordsByCodeId(codeRow.id);
  const redeemedAt = codeRow.redeemed_at || records[0]?.redeemed_at || "";

  if (records.length) {
    return {
      record_id: records[0].id || null,
      record_ids: records.map((record) => record.id),
      redeemed_count: records.length,
      code: rowToRedeemCode({
        ...codeRow,
        status: "redeemed",
        redeemed_quantity: Math.max(
          Number(codeRow.redeemed_quantity || 0),
          records.length,
        ),
        redeemed_inventory_id:
          codeRow.redeemed_inventory_id ?? records[0].inventory_id,
        redeemed_at: redeemedAt,
      }),
      inventories: records.map((record) =>
        recordToRedeemInventory(record, codeRow.id),
      ),
      type: rowToRedeemTypeFromCode(codeRow),
    };
  }

  const inventoryRows = db
    .prepare(
      `
        SELECT
          inventory.*,
          types.name AS type_name,
          types.slug AS type_slug,
          types.field_schema,
          types.mail_protocol,
          types.mail_protocols AS type_mail_protocols,
          types.import_delimiter
        FROM redeem_inventory inventory
        JOIN redeem_email_types types ON types.id = inventory.type_id
        WHERE
          inventory.redeemed_code_id = ?
          OR (? IS NOT NULL AND inventory.id = ?)
        ORDER BY inventory.id ASC
      `,
    )
    .all(
      codeRow.id,
      codeRow.redeemed_inventory_id,
      codeRow.redeemed_inventory_id,
    )
    .map(rowToRedeemInventory);

  if (!inventoryRows.length) {
    throw new Error("兑换码已兑换，但没有可查询的兑换结果");
  }

  return {
    record_id: null,
    record_ids: [],
    redeemed_count: inventoryRows.length,
    code: rowToRedeemCode({
      ...codeRow,
      status: "redeemed",
      redeemed_quantity: Math.max(
        Number(codeRow.redeemed_quantity || 0),
        inventoryRows.length,
      ),
      redeemed_inventory_id:
        codeRow.redeemed_inventory_id ?? inventoryRows[0].id,
      redeemed_at: codeRow.redeemed_at || inventoryRows[0].redeemed_at,
    }),
    inventories: inventoryRows,
    type: rowToRedeemTypeFromCode(codeRow),
  };
}

export function getAccount(email) {
  const row = db
    .prepare(
      "SELECT email, password, client_id, refresh_token FROM accounts WHERE email = ?",
    )
    .get(email);
  return row ? { email: row.email, ...rowToAccount(row) } : null;
}

export function getMailboxAccountFromInventory(email) {
  const normalizedEmail = normalizeLookupValue(email);
  if (!normalizedEmail) {
    return null;
  }

  const rows = db
    .prepare(
      `
        SELECT
          inventory.*,
          types.slug AS type_slug,
          types.name AS type_name,
          types.field_schema,
          types.mail_protocol,
          types.import_delimiter
        FROM redeem_inventory inventory
        JOIN redeem_email_types types ON types.id = inventory.type_id
        ORDER BY
          CASE inventory.status WHEN 'available' THEN 0 ELSE 1 END,
          inventory.updated_at DESC,
          inventory.id DESC
      `,
    )
    .all();

  for (const row of rows) {
    const payload = { raw_line: row.serialized_value || "" };
    const credentials = extractMailboxCredentials(payload);
    if (!credentials) {
      continue;
    }

    if (normalizeLookupValue(credentials.email) !== normalizedEmail) {
      continue;
    }

    return {
      ...credentials,
      source: "redeem_inventory",
      inventory_id: row.id,
      inventory_status: row.status,
      type_id: row.type_id,
      type_slug: row.type_slug,
      type_name: row.type_name,
      mail_protocols: normalizeMailProtocols(row.pickup_protocols, [
        row.mail_protocol,
      ]),
      mail_protocol: normalizeMailProtocols(row.pickup_protocols, [
        row.mail_protocol,
      ])[0],
      payload: payload,
      field_schema: row.field_schema
        ? parseRedeemFieldSchema(row.field_schema)
        : undefined,
      import_delimiter: row.import_delimiter || "----",
    };
  }

  return null;
}

export function updateRedeemInventoryPayload(inventoryId, payload) {
  const row = db
    .prepare(
      `
        SELECT
          inventory.*,
          types.field_schema,
          types.mail_protocol,
          types.import_delimiter
        FROM redeem_inventory inventory
        JOIN redeem_email_types types ON types.id = inventory.type_id
        WHERE inventory.id = ?
        LIMIT 1
      `,
    )
    .get(Number(inventoryId));

  if (!row) {
    return false;
  }

  const fieldSchema = row.field_schema
    ? parseRedeemFieldSchema(row.field_schema)
    : undefined;
  const delimiter = row.import_delimiter || "----";
  const serializedValue = serializeInventoryPayload(
    fieldSchema,
    payload,
    delimiter,
  );

  const result = db
    .prepare(
      `
        UPDATE redeem_inventory
        SET
          serialized_value = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
    )
    .run(serializedValue, Number(inventoryId));

  return result.changes > 0;
}

export function updateRedeemInventoryRefreshToken(inventoryId, refreshToken) {
  const row = db
    .prepare("SELECT serialized_value FROM redeem_inventory WHERE id = ? LIMIT 1")
    .get(Number(inventoryId));
  const nextRefreshToken = String(refreshToken || "").trim();
  if (!row || !nextRefreshToken) {
    return false;
  }

  const payload = { raw_line: row.serialized_value || "" };
  const credentials = extractMailboxCredentials(payload);
  if (!credentials || credentials.refresh_token === nextRefreshToken) {
    return false;
  }

  if (payload.raw_line) {
    payload.raw_line = [
      credentials.email,
      credentials.password || "",
      credentials.client_id || CLIENT_ID,
      nextRefreshToken,
    ].join("----");
  } else if (Object.prototype.hasOwnProperty.call(payload, "refreshtoken")) {
    payload.refreshtoken = nextRefreshToken;
  } else {
    payload.refresh_token = nextRefreshToken;
  }

  return updateRedeemInventoryPayload(inventoryId, payload);
}

export function upsertAccount({
  email,
  password = "",
  client_id = "",
  refresh_token,
}) {
  const stmt = db.prepare(`
    INSERT INTO accounts (email, password, client_id, refresh_token, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(email) DO UPDATE SET
      password = excluded.password,
      client_id = excluded.client_id,
      refresh_token = excluded.refresh_token,
      updated_at = CURRENT_TIMESTAMP
  `);
  return stmt.run(email, password, client_id, refresh_token).changes > 0;
}

export function getSystemConfig() {
  const value = db
    .prepare("SELECT value FROM system_config WHERE key = 'email_limit'")
    .get();
  return {
    email_limit: value ? Number(value.value) : DEFAULT_EMAIL_LIMIT,
  };
}

export function getSystemConfigValue(key) {
  const row = db
    .prepare("SELECT value FROM system_config WHERE key = ?")
    .get(String(key || ""));
  return row ? row.value : null;
}

export function setSystemConfigValue(key, value) {
  db.prepare(
    "INSERT INTO system_config (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP",
  ).run(key, String(value));
  return true;
}

export function getRedeemEmailTypes({ include_inactive = false } = {}) {
  const where = include_inactive ? "" : " WHERE t.is_active = 1";
  const rows = db
    .prepare(`${buildRedeemTypeSelect()}${where} ORDER BY t.id ASC`)
    .all();
  return rows.map(rowToRedeemType);
}

export function getRedeemEmailTypeById(typeId) {
  const row = db
    .prepare(`${buildRedeemTypeSelect()} WHERE t.id = ? LIMIT 1`)
    .get(Number(typeId));
  return rowToRedeemType(row);
}

export function getRedeemEmailTypeBySlug(slug) {
  const row = db
    .prepare(`${buildRedeemTypeSelect()} WHERE t.slug = ? LIMIT 1`)
    .get(String(slug || ""));
  return rowToRedeemType(row);
}

export function createRedeemEmailType(type) {
  const result = db
    .prepare(
      `
        INSERT INTO redeem_email_types (
          slug,
          name,
          description,
          field_schema,
          mail_protocol,
          mail_protocols,
          import_delimiter,
          is_active,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `,
    )
    .run(
      type.slug,
      type.name,
      type.description || "",
      JSON.stringify(type.field_schema),
      normalizeMailProtocols(type.mail_protocols, [type.mail_protocol])[0],
      JSON.stringify(
        normalizeMailProtocols(type.mail_protocols, [type.mail_protocol]),
      ),
      type.import_delimiter || "----",
      type.is_active ? 1 : 0,
    );

  return getRedeemEmailTypeById(result.lastInsertRowid);
}

export function updateRedeemEmailType(typeId, type) {
  const result = db
    .prepare(
      `
        UPDATE redeem_email_types
        SET
          slug = ?,
          name = ?,
          description = ?,
          field_schema = ?,
          mail_protocol = ?,
          mail_protocols = ?,
          import_delimiter = ?,
          is_active = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
    )
    .run(
      type.slug,
      type.name,
      type.description || "",
      JSON.stringify(type.field_schema),
      normalizeMailProtocols(type.mail_protocols, [type.mail_protocol])[0],
      JSON.stringify(
        normalizeMailProtocols(type.mail_protocols, [type.mail_protocol]),
      ),
      type.import_delimiter || "----",
      type.is_active ? 1 : 0,
      Number(typeId),
    );

  return result.changes > 0 ? getRedeemEmailTypeById(typeId) : null;
}

export function deleteRedeemEmailType(typeId) {
  const targetId = Number(typeId);
  if (!Number.isInteger(targetId) || targetId < 1) {
    return null;
  }

  const tx = db.transaction((id) => {
    const type = getRedeemEmailTypeById(id);
    if (!type) {
      return null;
    }

    // Records reference both inventory and codes, so remove them first even
    // though older databases do not declare foreign-key constraints.
    // 记录表不再存 type_id，按该类型的卡密反查。
    const deletedRecordCount = db
      .prepare(
        `
          DELETE FROM redeem_records
          WHERE code_id IN (SELECT id FROM redeem_codes WHERE type_id = ?)
        `,
      )
      .run(id).changes;
    const deletedInventoryCount = db
      .prepare("DELETE FROM redeem_inventory WHERE type_id = ?")
      .run(id).changes;
    const deletedCodeCount = db
      .prepare("DELETE FROM redeem_codes WHERE type_id = ?")
      .run(id).changes;
    const deletedTypeCount = db
      .prepare("DELETE FROM redeem_email_types WHERE id = ?")
      .run(id).changes;

    if (deletedTypeCount !== 1) {
      throw new Error("兑换类型删除失败");
    }

    return {
      type,
      deleted_type_count: deletedTypeCount,
      deleted_inventory_count: deletedInventoryCount,
      deleted_code_count: deletedCodeCount,
      deleted_record_count: deletedRecordCount,
    };
  });

  return tx(targetId);
}

export function ensureDefaultRedeemEmailType() {
  const exists = getRedeemEmailTypeBySlug(DEFAULT_REDEEM_EMAIL_TYPE.slug);
  if (exists) {
    return exists;
  }

  return createRedeemEmailType(DEFAULT_REDEEM_EMAIL_TYPE);
}

export function getRedeemAdminOverview() {
  const inventory = db
    .prepare(
      `
        SELECT
          COUNT(*) AS total_inventory_count,
          SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END) AS available_inventory_count,
          SUM(CASE WHEN status = 'unavailable' THEN 1 ELSE 0 END) AS unavailable_inventory_count,
          SUM(CASE WHEN status = 'redeemed' THEN 1 ELSE 0 END) AS redeemed_inventory_count
        FROM redeem_inventory
      `,
    )
    .get();
  const codes = db
    .prepare(
      `
        SELECT
          COUNT(*) AS total_code_count,
          SUM(CASE WHEN status = 'unused' THEN 1 ELSE 0 END) AS unused_code_count,
          SUM(CASE WHEN status = 'redeemed' THEN 1 ELSE 0 END) AS redeemed_code_count,
          SUM(CASE WHEN status = 'disabled' THEN 1 ELSE 0 END) AS disabled_code_count
        FROM redeem_codes
      `,
    )
    .get();
  const typeCount = db
    .prepare("SELECT COUNT(*) AS type_count FROM redeem_email_types")
    .get();
  const recordCount = db
    .prepare("SELECT COUNT(*) AS record_count FROM redeem_records")
    .get();

  return {
    type_count: Number(typeCount?.type_count || 0),
    total_inventory_count: Number(inventory?.total_inventory_count || 0),
    available_inventory_count: Number(
      inventory?.available_inventory_count || 0,
    ),
    unavailable_inventory_count: Number(
      inventory?.unavailable_inventory_count || 0,
    ),
    redeemed_inventory_count: Number(inventory?.redeemed_inventory_count || 0),
    total_code_count: Number(codes?.total_code_count || 0),
    unused_code_count: Number(codes?.unused_code_count || 0),
    redeemed_code_count: Number(codes?.redeemed_code_count || 0),
    disabled_code_count: Number(codes?.disabled_code_count || 0),
    record_count: Number(recordCount?.record_count || 0),
  };
}

export function getRedeemInventoryPaged({
  type_id = "",
  status = "",
  protocol = "",
  q = "",
  page = 1,
  page_size = 10,
} = {}) {
  const safePage = clampPositiveInt(page, 1);
  const safePageSize = clampPositiveInt(page_size, 10, 100);
  const { where, params } = buildRedeemInventoryWhere({
    type_id,
    status,
    protocol,
    q,
  });
  const totalRow = db
    .prepare(
      `
        SELECT COUNT(*) AS total
        FROM redeem_inventory inventory
        ${where}
      `,
    )
    .get(...params);

  const rows = db
    .prepare(
      `
        SELECT
          inventory.*,
          types.name AS type_name,
          types.slug AS type_slug,
          types.field_schema,
          types.mail_protocol,
          types.import_delimiter
        FROM redeem_inventory inventory
        JOIN (
          SELECT id
          FROM redeem_inventory inventory
          ${where}
          ORDER BY inventory.id DESC
          LIMIT ? OFFSET ?
        ) page ON page.id = inventory.id
        JOIN redeem_email_types types ON types.id = inventory.type_id
        ORDER BY inventory.id DESC
      `,
    )
    .all(...params, safePageSize, Math.max(0, (safePage - 1) * safePageSize));

  return {
    items: rows.map(rowToRedeemInventory),
    total: Number(totalRow?.total || 0),
    page: safePage,
    page_size: safePageSize,
  };
}

export function getRedeemInventoryIds(filters = {}) {
  const { where, params } = buildRedeemInventoryWhere(filters);
  return db
    .prepare(
      `
        SELECT inventory.id
        FROM redeem_inventory inventory
        ${where}
        ORDER BY inventory.id DESC
      `,
    )
    .all(...params)
    .map((row) => Number(row.id));
}

export function getRedeemInventorySelectionCount(filters = {}) {
  const { where, params } = buildRedeemInventoryWhere(filters);
  const row = db
    .prepare(`SELECT COUNT(*) AS total FROM redeem_inventory inventory ${where}`)
    .get(...params);
  return Number(row?.total || 0);
}

export function importRedeemInventory({
  type_id,
  items = [],
  mode = "append",
  mail_protocols = [],
}) {
  const type = getRedeemEmailTypeById(type_id);
  if (!type) {
    throw new Error("兑换类型不存在");
  }

  const normalizedMode =
    mode === "replace_available" ? "replace_available" : "append";
  const allowedProtocols = normalizeMailProtocols(type.mail_protocols, [
    type.mail_protocol,
  ]);
  const pickupProtocols = normalizeMailProtocols(
    mail_protocols,
    allowedProtocols,
  );
  if (
    pickupProtocols.some((protocol) => !allowedProtocols.includes(protocol))
  ) {
    throw new Error("导入协议不在该兑换类型允许的协议范围内");
  }
  const tx = db.transaction((targetType, nextItems, nextMode) => {
    let cleared = 0;
    let added = 0;
    let protocolsUpdated = 0;
    let skipped = 0;

    if (nextMode === "replace_available") {
      cleared = db
        .prepare(
          "DELETE FROM redeem_inventory WHERE type_id = ? AND status = 'available'",
        )
        .run(targetType.id).changes;
    }

    const insertStmt = db.prepare(
      `
        INSERT OR IGNORE INTO redeem_inventory (
          type_id,
          serialized_value,
          pickup_protocols,
          pickup_imap,
          pickup_graph,
          status,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, 'available', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `,
    );
    const existingStmt = db.prepare(
      "SELECT id, pickup_protocols FROM redeem_inventory WHERE type_id = ? AND serialized_value = ? LIMIT 1",
    );
    const mergeProtocolsStmt = db.prepare(
      "UPDATE redeem_inventory SET pickup_protocols = ?, pickup_imap = ?, pickup_graph = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    );

    for (const item of nextItems) {
      const payload = item.payload || {};
      const serializedValue =
        item.serialized_value ||
        serializeInventoryPayload(
          targetType.field_schema,
          payload,
          targetType.import_delimiter,
        );
      const flags = protocolFlags(pickupProtocols);
      const result = insertStmt.run(
        targetType.id,
        serializedValue,
        JSON.stringify(pickupProtocols),
        flags.pickup_imap,
        flags.pickup_graph,
      );

      if (result.changes > 0) {
        added += 1;
      } else {
        const existing = existingStmt.get(targetType.id, serializedValue);
        if (existing) {
          const existingProtocols = normalizeMailProtocols(
            existing.pickup_protocols,
            [],
          );
          const merged = normalizeMailProtocols(
            [
              ...existingProtocols,
              ...pickupProtocols,
            ],
            pickupProtocols,
          );
          if (
            merged.length !== existingProtocols.length ||
            merged.some((protocol) => !existingProtocols.includes(protocol))
          ) {
            const mergedFlags = protocolFlags(merged);
            protocolsUpdated += mergeProtocolsStmt.run(
              JSON.stringify(merged),
              mergedFlags.pickup_imap,
              mergedFlags.pickup_graph,
              existing.id,
            ).changes;
          }
        }
        skipped += 1;
      }
    }

    return {
      mode: nextMode,
      cleared_count: cleared,
      added_count: added,
      protocols_updated_count: protocolsUpdated,
      skipped_count: skipped,
      total_count: nextItems.length,
    };
  });

  return tx(type, items, normalizedMode);
}

export function updateRedeemInventoryStatus(inventoryId, status) {
  const nextStatus = status === "unavailable" ? "unavailable" : "available";
  const row = db
    .prepare(
      `
        SELECT
          inventory.*,
          types.name AS type_name,
          types.slug AS type_slug,
          types.field_schema,
          types.mail_protocol,
          types.import_delimiter
        FROM redeem_inventory inventory
        JOIN redeem_email_types types ON types.id = inventory.type_id
        WHERE inventory.id = ?
        LIMIT 1
      `,
    )
    .get(Number(inventoryId));

  if (!row) {
    return null;
  }

  if (row.status === "redeemed") {
    throw new Error("已兑换的库存不能修改状态");
  }

  if (row.status !== nextStatus) {
    db.prepare(
      "UPDATE redeem_inventory SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).run(nextStatus, Number(inventoryId));
  }

  return rowToRedeemInventory({ ...row, status: nextStatus });
}

export function updateRedeemInventoryBatch(
  ids,
  { type_id = null, status = null } = {},
) {
  const targets = normalizeIdTargets(ids);
  const nextStatus =
    status === "available" || status === "unavailable" ? status : null;
  const nextTypeId =
    Number.isInteger(Number(type_id)) && Number(type_id) > 0
      ? Number(type_id)
      : null;

  if (!nextStatus && !nextTypeId) {
    throw new Error("请至少指定一个库存修改项");
  }

  const nextType = nextTypeId ? getRedeemEmailTypeById(nextTypeId) : null;
  if (nextTypeId && !nextType) {
    throw new Error("兑换类型不存在");
  }

  // 只改状态：一条分块 UPDATE 搞定，避免逐行 SELECT + UPDATE。
  if (!nextTypeId) {
    const tx = db.transaction((items, targetStatus) => {
      let updatedCount = 0;
      for (const chunk of chunkArray(items)) {
        updatedCount += prepareCached(
          `
            UPDATE redeem_inventory
            SET status = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id IN (${placeholders(chunk.length)})
              AND status != 'redeemed'
              AND status != ?
          `,
        ).run(targetStatus, ...chunk, targetStatus).changes;
      }

      return {
        updated_count: updatedCount,
        skipped_count: items.length - updatedCount,
        total_count: items.length,
        status: targetStatus,
        type_id: null,
      };
    });

    return tx(targets, nextStatus);
  }

  const tx = db.transaction((items, targetStatus, targetType) => {
    let updatedCount = 0;
    let skippedCount = 0;
    const updateStmt = db.prepare(
      `
        UPDATE redeem_inventory
        SET
          type_id = ?,
          serialized_value = ?,
          status = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
    );
    const duplicateStmt = db.prepare(
      `
        SELECT id
        FROM redeem_inventory
        WHERE type_id = ? AND serialized_value = ? AND id != ?
        LIMIT 1
      `,
    );

    for (const chunk of chunkArray(items)) {
      const rows = prepareCached(
        `
          SELECT
            inventory.*,
            types.field_schema,
            types.mail_protocol,
            types.import_delimiter
          FROM redeem_inventory inventory
          JOIN redeem_email_types types ON types.id = inventory.type_id
          WHERE inventory.id IN (${placeholders(chunk.length)})
        `,
      ).all(...chunk);
      const rowById = new Map(rows.map((row) => [Number(row.id), row]));

      for (const id of chunk) {
        const row = rowById.get(id);
        if (!row || row.status === "redeemed") {
          skippedCount += 1;
          continue;
        }

        const payload = { raw_line: row.serialized_value || "" };
        const finalTypeId = targetType ? targetType.id : row.type_id;
        const finalFieldSchema = targetType
          ? targetType.field_schema
          : parseRedeemFieldSchema(row.field_schema);
        const finalDelimiter = targetType
          ? targetType.import_delimiter
          : row.import_delimiter || "----";
        const finalSerializedValue = serializeInventoryPayload(
          finalFieldSchema,
          payload,
          finalDelimiter,
        );
        const finalStatus = targetStatus || row.status;

        if (
          finalTypeId === row.type_id &&
          finalSerializedValue === row.serialized_value &&
          finalStatus === row.status
        ) {
          skippedCount += 1;
          continue;
        }

        if (
          finalSerializedValue !== row.serialized_value &&
          duplicateStmt.get(finalTypeId, finalSerializedValue, id)
        ) {
          skippedCount += 1;
          continue;
        }

        updatedCount += updateStmt.run(
          finalTypeId,
          finalSerializedValue,
          finalStatus,
          id,
        ).changes;
      }
    }

    return {
      updated_count: updatedCount,
      skipped_count: skippedCount,
      total_count: items.length,
      status: targetStatus,
      type_id: targetType ? targetType.id : null,
    };
  });

  return tx(targets, nextStatus, nextType);
}

export function deleteRedeemInventory(inventoryId) {
  const result = db
    .prepare("DELETE FROM redeem_inventory WHERE id = ?")
    .run(Number(inventoryId));
  return result.changes > 0;
}

export function deleteRedeemInventoryBatch(ids) {
  const targets = normalizeIdTargets(ids);
  const tx = db.transaction((items) => {
    let deleted = 0;
    for (const chunk of chunkArray(items)) {
      deleted += prepareCached(
        `DELETE FROM redeem_inventory WHERE id IN (${placeholders(chunk.length)})`,
      ).run(...chunk).changes;
    }
    return deleted;
  });
  return tx(targets);
}

export function getRedeemInventoryIdsForCheck({ type_id, status = "" } = {}) {
  const conditions = [];
  const params = [];

  if (type_id) {
    conditions.push("type_id = ?");
    params.push(Number(type_id));
  }

  if (
    status === "available" ||
    status === "unavailable" ||
    status === "redeemed"
  ) {
    conditions.push("status = ?");
    params.push(status);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT id FROM redeem_inventory ${where} ORDER BY id ASC`)
    .all(...params);
  return rows.map((row) => Number(row.id));
}

export function getMailboxInventoryAccounts({ type_id, status = "" } = {}) {
  const conditions = [];
  const params = [];

  if (type_id) {
    conditions.push("inventory.type_id = ?");
    params.push(Number(type_id));
  }

  if (
    status === "available" ||
    status === "unavailable" ||
    status === "redeemed"
  ) {
    conditions.push("inventory.status = ?");
    params.push(status);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `
        SELECT
          inventory.*,
          types.name AS type_name,
          types.slug AS type_slug,
          types.field_schema,
          types.mail_protocol,
          types.import_delimiter
        FROM redeem_inventory inventory
        JOIN redeem_email_types types ON types.id = inventory.type_id
        ${where}
        ORDER BY inventory.id ASC
      `,
    )
    .all(...params);

  const accounts = [];
  const seenEmails = new Set();
  for (const row of rows) {
    const item = rowToRedeemInventory(row);
    const credentials = extractMailboxCredentials(item?.payload || {});
    if (!credentials) {
      continue;
    }

    const emailKey = normalizeLookupValue(credentials.email);
    if (seenEmails.has(emailKey)) {
      continue;
    }
    seenEmails.add(emailKey);

    accounts.push({
      inventory_id: item.id,
      type_id: item.type_id,
      type_name: item.type_name,
      type_slug: item.type_slug,
      mail_protocol: item.mail_protocol,
      status: item.status,
      source: "redeem_inventory",
      payload: item.payload,
      ...credentials,
    });
  }

  return accounts;
}

function parseRedeemedAtTimestamp(redeemedAt) {
  const rawRedeemedAt = String(redeemedAt || "").trim();
  const normalizedRedeemedAt = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(
    rawRedeemedAt,
  )
    ? `${rawRedeemedAt.replace(" ", "T")}Z`
    : rawRedeemedAt;
  const redeemedTimestamp = Date.parse(normalizedRedeemedAt);
  return Number.isFinite(redeemedTimestamp) ? redeemedTimestamp : null;
}

export function isRedeemAccessExpired(redeemedAt, now = Date.now()) {
  const redeemedTimestamp = parseRedeemedAtTimestamp(redeemedAt);
  if (redeemedTimestamp === null) {
    return false;
  }

  return redeemedTimestamp + REDEEM_ACCESS_TTL_MS <= Number(now);
}

export function getRedeemAccessExpiresAt(redeemedAt) {
  const redeemedTimestamp = parseRedeemedAtTimestamp(redeemedAt);
  if (redeemedTimestamp === null) {
    return null;
  }

  return new Date(redeemedTimestamp + REDEEM_ACCESS_TTL_MS).toISOString();
}

export function getRedeemAccessTtlHours() {
  return Math.round((REDEEM_ACCESS_TTL_MS / (60 * 60 * 1000)) * 10) / 10;
}

export function purgeExpiredRedeemDataByCodeId(codeId, now = Date.now()) {
  const targetId = Number(codeId);
  const code = db
    .prepare(
      "SELECT id, code, status, redeemed_at, data_deleted_at FROM redeem_codes WHERE id = ? LIMIT 1",
    )
    .get(targetId);
  if (
    !code ||
    code.status !== "redeemed" ||
    !isRedeemAccessExpired(code.redeemed_at, now)
  ) {
    return null;
  }

  return {
    code_id: targetId,
    code: code.code,
    deleted_inventory_count: 0,
    deleted_record_count: 0,
    already_deleted: Boolean(code.data_deleted_at),
    preserved: true,
  };
}

export function purgeExpiredRedeemData(now = Date.now()) {
  const rows = db
    .prepare(
      `
        SELECT id
        FROM redeem_codes
        WHERE status = 'redeemed' AND redeemed_at IS NOT NULL AND data_deleted_at IS NULL
      `,
    )
    .all();
  const results = [];
  for (const row of rows) {
    const result = purgeExpiredRedeemDataByCodeId(row.id, now);
    if (result) {
      results.push(result);
    }
  }
  return results;
}

export function rollbackRedeemCode(codeId) {
  const targetId = Number(codeId);
  const tx = db.transaction((id) => {
    const code = db
      .prepare("SELECT * FROM redeem_codes WHERE id = ? LIMIT 1")
      .get(id);
    if (!code) {
      return null;
    }
    if (code.status !== "redeemed") {
      throw new Error("只有已兑换的卡密可以回退");
    }

    const inventoryIds = db
      .prepare("SELECT inventory_id FROM redeem_records WHERE code_id = ?")
      .all(id)
      .map((row) => Number(row.inventory_id));
    const restoredByCode = db
      .prepare(
        `
          UPDATE redeem_inventory
          SET
            status = 'available',
            redeemed_code_id = NULL,
            redeemed_at = NULL,
            updated_at = CURRENT_TIMESTAMP
          WHERE redeemed_code_id = ?
        `,
      )
      .run(id).changes;
    let restoredByRecord = 0;
    const restoreInventory = db.prepare(
      `
        UPDATE redeem_inventory
        SET
          status = 'available',
          redeemed_code_id = NULL,
          redeemed_at = NULL,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'redeemed'
      `,
    );
    for (const inventoryId of inventoryIds) {
      restoredByRecord += restoreInventory.run(inventoryId).changes;
    }

    const deletedRecordCount = db
      .prepare("DELETE FROM redeem_records WHERE code_id = ?")
      .run(id).changes;
    db.prepare("DELETE FROM redeem_codes WHERE id = ?").run(id);

    return {
      code_id: id,
      code: code.code,
      restored_inventory_count: restoredByCode + restoredByRecord,
      deleted_record_count: deletedRecordCount,
    };
  });

  return tx(targetId);
}

export function getRedeemInventoryByIds(ids) {
  const targets = [
    ...new Set(
      (ids || [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0),
    ),
  ];
  if (!targets.length) {
    return [];
  }

  const rows = [];
  for (let index = 0; index < targets.length; index += 500) {
    const chunk = targets.slice(index, index + 500);
    const placeholders = chunk.map(() => "?").join(", ");
    rows.push(
      ...db
        .prepare(
          `
            SELECT
              inventory.*,
              types.name AS type_name,
              types.slug AS type_slug,
              types.field_schema,
              types.mail_protocol,
              types.import_delimiter
            FROM redeem_inventory inventory
            JOIN redeem_email_types types ON types.id = inventory.type_id
            WHERE inventory.id IN (${placeholders})
          `,
        )
        .all(...chunk),
    );
  }
  rows.sort((left, right) => Number(left.id) - Number(right.id));

  return rows.map(rowToRedeemInventory);
}

export function getRedeemCodesPaged({
  type_id = "",
  status = "",
  q = "",
  min_quantity = "",
  max_quantity = "",
  page = 1,
  page_size = 10,
} = {}) {
  const safePage = clampPositiveInt(page, 1);
  const safePageSize = clampPositiveInt(page_size, 10, 100);
  const { where, params } = buildRedeemCodesWhere({
    type_id,
    status,
    q,
    min_quantity,
    max_quantity,
  });
  const totalRow = db
    .prepare(
      `
        SELECT COUNT(*) AS total
        FROM redeem_codes codes
        ${where}
      `,
    )
    .get(...params);

  const rows = db
    .prepare(
      `
        SELECT
          codes.*,
          types.name AS type_name,
          types.slug AS type_slug
        FROM redeem_codes codes
        JOIN (
          SELECT id
          FROM redeem_codes codes
          ${where}
          ORDER BY codes.id DESC
          LIMIT ? OFFSET ?
        ) page ON page.id = codes.id
        JOIN redeem_email_types types ON types.id = codes.type_id
        ORDER BY codes.id DESC
      `,
    )
    .all(...params, safePageSize, Math.max(0, (safePage - 1) * safePageSize));

  return {
    items: rows.map(rowToRedeemCode),
    total: Number(totalRow?.total || 0),
    page: safePage,
    page_size: safePageSize,
  };
}

export function getRedeemCodeIds(filters = {}) {
  const { where, params } = buildRedeemCodesWhere(filters);
  return db
    .prepare(
      `
        SELECT codes.id
        FROM redeem_codes codes
        ${where}
        ORDER BY codes.id DESC
      `,
    )
    .all(...params)
    .map((row) => Number(row.id));
}

export function getRedeemCodeSelectionCount(filters = {}) {
  const { where, params } = buildRedeemCodesWhere(filters);
  const row = db
    .prepare(`SELECT COUNT(*) AS total FROM redeem_codes codes ${where}`)
    .get(...params);
  return Number(row?.total || 0);
}

export function getRedeemCodesByIds(ids) {
  const targets = [
    ...new Set(
      (ids || [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0),
    ),
  ];
  if (!targets.length) {
    return [];
  }

  const rows = [];
  for (let index = 0; index < targets.length; index += 500) {
    const chunk = targets.slice(index, index + 500);
    const placeholders = chunk.map(() => "?").join(", ");
    rows.push(
      ...db
        .prepare(
          `
            SELECT
              codes.*,
              types.name AS type_name,
              types.slug AS type_slug
            FROM redeem_codes codes
            JOIN redeem_email_types types ON types.id = codes.type_id
            WHERE codes.id IN (${placeholders})
          `,
        )
        .all(...chunk),
    );
  }
  rows.sort((left, right) => Number(left.id) - Number(right.id));

  return rows.map(rowToRedeemCode);
}

export function getRedeemCodesForExport({
  type_id = "",
  status = "",
  q = "",
  min_quantity = "",
  max_quantity = "",
} = {}) {
  const { where, params } = buildRedeemCodesWhere({
    type_id,
    status,
    q,
    min_quantity,
    max_quantity,
  });
  const rows = db
    .prepare(
      `
        SELECT
          codes.*,
          types.name AS type_name,
          types.slug AS type_slug
        FROM redeem_codes codes
        JOIN redeem_email_types types ON types.id = codes.type_id
        ${where}
        ORDER BY codes.id DESC
      `,
    )
    .all(...params);

  return rows.map(rowToRedeemCode);
}

export function getRedeemCodeByCode(code) {
  const normalizedCode = normalizeRedeemCode(code);
  if (!normalizedCode) {
    return null;
  }

  const row = db
    .prepare(
      `
        SELECT
          codes.*,
          types.name AS type_name,
          types.slug AS type_slug
        FROM redeem_codes codes
        JOIN redeem_email_types types ON types.id = codes.type_id
        WHERE codes.normalized_code = ?
        LIMIT 1
      `,
    )
    .get(normalizedCode);

  return rowToRedeemCode(row);
}

export function getRedeemRecordsByCodeId(codeId) {
  const rows = db
    .prepare(
      `
        SELECT
          records.id,
          records.code_id,
          records.inventory_id,
          records.requester_ip,
          records.requester_user_agent,
          records.redeemed_at,
          -- 账号内容只在库存表里存一份；孤儿记录退回 payload_raw 快照。
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
        WHERE records.code_id = ?
        ORDER BY records.id ASC
      `,
    )
    .all(Number(codeId));

  return rows.map(rowToRedeemRecord);
}

export function getRedeemRecordsByCodeIdPaged(
  codeId,
  { page = 1, page_size = 10 } = {},
) {
  const safeCodeId = Number(codeId);
  const safePage = clampPositiveInt(page, 1);
  const safePageSize = clampPositiveInt(page_size, 10, 100);
  const totalRow = db
    .prepare(
      `
        SELECT COUNT(*) AS total
        FROM redeem_records
        WHERE code_id = ?
      `,
    )
    .get(safeCodeId);

  const rows = db
    .prepare(
      `
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
        WHERE records.code_id = ?
        ORDER BY records.id ASC
        LIMIT ? OFFSET ?
      `,
    )
    .all(safeCodeId, safePageSize, Math.max(0, (safePage - 1) * safePageSize));

  return {
    items: rows.map(rowToRedeemRecord),
    total: Number(totalRow?.total || 0),
    page: safePage,
    page_size: safePageSize,
  };
}

export function createRedeemCodes({
  type_id,
  count = 1,
  quantity = 1,
  note = "",
  expires_at = null,
}) {
  const type = getRedeemEmailTypeById(type_id);
  if (!type) {
    throw new Error("兑换类型不存在");
  }

  const safeCount = clampPositiveInt(count, 1);
  const safeQuantity = clampPositiveInt(quantity, 1);
  const tx = db.transaction(
    (targetType, amount, nextQuantity, nextNote, nextExpiresAt) => {
      const created = [];
      const insertStmt = db.prepare(
        `
        INSERT INTO redeem_codes (
          code,
          normalized_code,
          type_id,
          quantity,
          redeemed_quantity,
          note,
          status,
          expires_at,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, 0, ?, 'unused', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `,
      );

      for (let index = 0; index < amount; index += 1) {
        let inserted = false;

        for (let attempt = 0; attempt < 50; attempt += 1) {
          const code = generateRedeemCode();
          const normalizedCode = normalizeRedeemCode(code);

          try {
            const result = insertStmt.run(
              code,
              normalizedCode,
              targetType.id,
              nextQuantity,
              nextNote,
              nextExpiresAt,
            );
            created.push(
              rowToRedeemCode({
                id: result.lastInsertRowid,
                code,
                normalized_code: normalizedCode,
                type_id: targetType.id,
                type_name: targetType.name,
                type_slug: targetType.slug,
                quantity: nextQuantity,
                redeemed_quantity: 0,
                note: nextNote,
                status: "unused",
                expires_at: nextExpiresAt,
                redeemed_inventory_id: null,
                redeemed_at: null,
                created_at: nowTimestamp(),
                updated_at: nowTimestamp(),
              }),
            );
            inserted = true;
            break;
          } catch (error) {
            if (String(error.message || "").includes("UNIQUE")) {
              continue;
            }
            throw error;
          }
        }

        if (!inserted) {
          throw new Error("生成兑换码冲突过多，请稍后重试");
        }
      }

      return created;
    },
  );

  return tx(
    type,
    safeCount,
    safeQuantity,
    String(note || "").trim(),
    expires_at || null,
  );
}

export function updateRedeemCodeStatus(codeId, status) {
  const nextStatus = status === "disabled" ? "disabled" : "unused";
  const row = db
    .prepare(
      `
        SELECT
          codes.*,
          types.name AS type_name,
          types.slug AS type_slug
        FROM redeem_codes codes
        JOIN redeem_email_types types ON types.id = codes.type_id
        WHERE codes.id = ?
        LIMIT 1
      `,
    )
    .get(Number(codeId));

  if (!row) {
    return null;
  }

  if (row.status === "redeemed") {
    throw new Error("已兑换的卡密不能修改状态");
  }

  db.prepare(
    "UPDATE redeem_codes SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  ).run(nextStatus, Number(codeId));

  return rowToRedeemCode({ ...row, status: nextStatus });
}

export function updateRedeemCodeBatch(
  ids,
  { type_id = null, quantity = null } = {},
) {
  const targets = normalizeIdTargets(ids);
  const nextTypeId =
    Number.isInteger(Number(type_id)) && Number(type_id) > 0
      ? Number(type_id)
      : null;
  const nextQuantity =
    Number.isInteger(Number(quantity)) && Number(quantity) > 0
      ? Number(quantity)
      : null;

  if (!nextTypeId && !nextQuantity) {
    throw new Error("请至少指定一个卡密修改项");
  }

  const nextType = nextTypeId ? getRedeemEmailTypeById(nextTypeId) : null;
  if (nextTypeId && !nextType) {
    throw new Error("兑换类型不存在");
  }

  const tx = db.transaction((items, targetType, targetQuantity) => {
    let updatedCount = 0;
    let skippedCount = 0;
    const updateStmt = db.prepare(
      `
        UPDATE redeem_codes
        SET
          type_id = ?,
          quantity = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
    );

    for (const chunk of chunkArray(items)) {
      const rows = prepareCached(
        `
          SELECT codes.*
          FROM redeem_codes codes
          WHERE codes.id IN (${placeholders(chunk.length)})
        `,
      ).all(...chunk);
      const rowById = new Map(rows.map((row) => [Number(row.id), row]));

      for (const id of chunk) {
        const row = rowById.get(id);
        if (!row || row.status === "redeemed") {
          skippedCount += 1;
          continue;
        }

        const finalTypeId = targetType ? targetType.id : row.type_id;
        const finalQuantity =
          targetQuantity || Math.max(1, Number(row.quantity || 1));

        if (
          finalTypeId === row.type_id &&
          finalQuantity === Number(row.quantity || 1)
        ) {
          skippedCount += 1;
          continue;
        }

        updatedCount += updateStmt.run(finalTypeId, finalQuantity, id).changes;
      }
    }

    return {
      updated_count: updatedCount,
      skipped_count: skippedCount,
      total_count: items.length,
      type_id: targetType ? targetType.id : null,
      quantity: targetQuantity,
    };
  });

  return tx(targets, nextType, nextQuantity);
}

export function updateRedeemCodeStatusBatch(ids, status) {
  const nextStatus = status === "disabled" ? "disabled" : "unused";
  const targets = normalizeIdTargets(ids);

  const tx = db.transaction((items, targetStatus) => {
    let updatedCount = 0;

    for (const chunk of chunkArray(items)) {
      updatedCount += prepareCached(
        `
          UPDATE redeem_codes
          SET status = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id IN (${placeholders(chunk.length)})
            AND status != 'redeemed'
            AND status != ?
        `,
      ).run(targetStatus, ...chunk, targetStatus).changes;
    }

    return {
      updated_count: updatedCount,
      skipped_count: items.length - updatedCount,
      total_count: items.length,
      status: targetStatus,
    };
  });

  return tx(targets, nextStatus);
}

export function deleteRedeemCode(codeId) {
  const targetId = Number(codeId);
  const row = db
    .prepare("SELECT id, status FROM redeem_codes WHERE id = ? LIMIT 1")
    .get(targetId);

  if (!row) {
    return null;
  }

  if (row.status === "redeemed") {
    throw new Error("已兑换的卡密不能删除");
  }

  const result = db
    .prepare("DELETE FROM redeem_codes WHERE id = ?")
    .run(targetId);
  return result.changes > 0;
}

export function deleteRedeemCodeBatch(ids) {
  const targets = normalizeIdTargets(ids);
  const tx = db.transaction((items) => {
    let deletedCount = 0;
    let skippedCount = 0;
    const deletable = [];

    for (const chunk of chunkArray(items)) {
      const rows = prepareCached(
        `SELECT id, status FROM redeem_codes WHERE id IN (${placeholders(chunk.length)})`,
      ).all(...chunk);
      const statusById = new Map(
        rows.map((row) => [Number(row.id), row.status]),
      );

      for (const id of chunk) {
        const status = statusById.get(id);
        if (status === undefined || status === "redeemed") {
          skippedCount += 1;
          continue;
        }
        deletable.push(id);
      }
    }

    for (const chunk of chunkArray(deletable)) {
      deletedCount += prepareCached(
        `DELETE FROM redeem_codes WHERE id IN (${placeholders(chunk.length)})`,
      ).run(...chunk).changes;
    }

    return {
      deleted_count: deletedCount,
      skipped_count: skippedCount,
      total_count: items.length,
    };
  });

  return tx(targets);
}

export function redeemByCode({
  code,
  requester_ip = "",
  requester_user_agent = "",
}) {
  const normalizedCode = normalizeRedeemCode(code);
  if (!normalizedCode) {
    throw new Error("请输入兑换码");
  }

  const tx = db.transaction((targetCode, requesterIp, requesterUserAgent) => {
    const codeRow = db
      .prepare(
        `
          SELECT
            codes.*,
            types.name AS type_name,
            types.slug AS type_slug,
            types.field_schema,
            types.mail_protocol,
            types.mail_protocols,
            types.import_delimiter,
            types.description
          FROM redeem_codes codes
          JOIN redeem_email_types types ON types.id = codes.type_id
          WHERE codes.normalized_code = ?
          LIMIT 1
        `,
      )
      .get(targetCode);

    if (!codeRow) {
      throw new Error("兑换码不存在");
    }

    if (codeRow.status === "disabled") {
      throw new Error("兑换码已禁用");
    }

    if (codeRow.status === "redeemed") {
      if (
        codeRow.data_deleted_at ||
        isRedeemAccessExpired(codeRow.redeemed_at)
      ) {
        throw new Error(
          "兑换已超过24小时，账号信息已删除；取件请手动导入账号数据",
        );
      }
      return buildExistingRedeemResult(codeRow);
    }

    if (codeRow.expires_at && Date.parse(codeRow.expires_at) <= Date.now()) {
      throw new Error("兑换码已过期");
    }

    const quantity = Math.max(1, Number(codeRow.quantity || 1));
    const allowedProtocols = normalizeMailProtocols(codeRow.mail_protocols, [
      codeRow.mail_protocol,
    ]);
    // 用物化标志列直接按索引取号：命中即选定协议，避免对 13w 行做 json_each 全表统计。
    const selectAvailableByProtocol = {
      imap: db.prepare(
        `SELECT * FROM redeem_inventory WHERE type_id = ? AND status = 'available' AND pickup_imap = 1 ORDER BY id ASC LIMIT ?`,
      ),
      graph: db.prepare(
        `SELECT * FROM redeem_inventory WHERE type_id = ? AND status = 'available' AND pickup_graph = 1 ORDER BY id ASC LIMIT ?`,
      ),
    };

    let selectedProtocol = "";
    let inventoryRows = [];
    for (const protocol of allowedProtocols) {
      const stmt = selectAvailableByProtocol[protocol];
      if (!stmt) {
        continue;
      }

      const rows = stmt.all(codeRow.type_id, quantity);
      if (rows.length >= quantity) {
        selectedProtocol = protocol;
        inventoryRows = rows;
        break;
      }
    }

    if (!selectedProtocol) {
      // 失败路径才统计，用于给出可读的库存提示。
      const countAvailableByProtocol = {
        imap: db.prepare(
          `SELECT COUNT(*) AS count FROM redeem_inventory WHERE type_id = ? AND status = 'available' AND pickup_imap = 1`,
        ),
        graph: db.prepare(
          `SELECT COUNT(*) AS count FROM redeem_inventory WHERE type_id = ? AND status = 'available' AND pickup_graph = 1`,
        ),
      };
      const countSummary = allowedProtocols
        .map((protocol) => {
          const row = countAvailableByProtocol[protocol]?.get(codeRow.type_id);
          return `${protocol === "graph" ? "Graph" : "IMAP"} ${Number(row?.count || 0)} 份`;
        })
        .join("，");
      throw new Error(
        `当前类型没有单一协议的足够库存，至少需要 ${quantity} 份（${countSummary}）`,
      );
    }

    if (inventoryRows.length < quantity) {
      throw new Error("库存领取冲突，请稍后重试");
    }

    const redeemedAt = nowTimestamp();
    // pickup_protocols records what the account itself can be picked up with,
    // so redemption must not narrow it to the protocol this batch was drawn
    // from: the mail console fetches through every protocol the row allows.
    const updateInventoryStmt = db.prepare(
      `
        UPDATE redeem_inventory
        SET
          status = 'redeemed',
          redeemed_code_id = ?,
          redeemed_at = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'available'
      `,
    );
    // 只写关联关系，不再复制账号内容 / 卡密码 / 类型：这些都能按 id 查到。
    const insertRecordStmt = db.prepare(
      `
        INSERT INTO redeem_records (
          code_id,
          inventory_id,
          requester_ip,
          requester_user_agent,
          redeemed_at
        )
        VALUES (?, ?, ?, ?, ?)
      `,
    );
    const inventories = [];
    const recordIds = [];

    for (const inventoryRow of inventoryRows) {
      const inventoryUpdate = updateInventoryStmt.run(
        codeRow.id,
        redeemedAt,
        inventoryRow.id,
      );

      if (!inventoryUpdate.changes) {
        throw new Error("库存领取失败，请稍后重试");
      }

      const recordResult = insertRecordStmt.run(
        codeRow.id,
        inventoryRow.id,
        requesterIp,
        requesterUserAgent,
        redeemedAt,
      );

      recordIds.push(Number(recordResult.lastInsertRowid));
      inventories.push(
        rowToRedeemInventory({
          ...inventoryRow,
          type_name: codeRow.type_name,
          type_slug: codeRow.type_slug,
          field_schema: codeRow.field_schema,
          mail_protocol: codeRow.mail_protocol,
          type_mail_protocols: codeRow.mail_protocols,
          import_delimiter: codeRow.import_delimiter,
          status: "redeemed",
          redeemed_code_id: codeRow.id,
          redeemed_at: redeemedAt,
        }),
      );
    }

    const codeUpdate = db
      .prepare(
        `
          UPDATE redeem_codes
          SET
            status = 'redeemed',
            redeemed_inventory_id = ?,
            redeemed_quantity = ?,
            redeemed_at = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'unused'
        `,
      )
      .run(inventoryRows[0].id, quantity, redeemedAt, codeRow.id);

    if (!codeUpdate.changes) {
      throw new Error("兑换码状态更新失败，请稍后重试");
    }

    return {
      record_id: recordIds[0] || null,
      record_ids: recordIds,
      redeemed_count: quantity,
      code: rowToRedeemCode({
        ...codeRow,
        quantity,
        redeemed_quantity: quantity,
        status: "redeemed",
        redeemed_inventory_id: inventoryRows[0].id,
        redeemed_at: redeemedAt,
      }),
      inventories,
      type: rowToRedeemTypeFromCode(codeRow),
    };
  });

  return tx.immediate(
    normalizedCode,
    String(requester_ip || "").trim(),
    String(requester_user_agent || "").trim(),
  );
}

export function getRedeemRecordsPaged({
  type_id = "",
  q = "",
  page = 1,
  page_size = 10,
} = {}) {
  const safePage = clampPositiveInt(page, 1);
  const safePageSize = clampPositiveInt(page_size, 10, 100);
  const conditions = [];
  const params = [];

  if (type_id) {
    // 记录表不再存 type_id：类型归属只存在于 redeem_codes，按 code_id 关联判断。
    conditions.push("codes.type_id = ?");
    params.push(Number(type_id));
  }

  if (q) {
    conditions.push(
      "(codes.normalized_code LIKE ? OR inventory.search_text LIKE ?)",
    );
    const search = `%${normalizeRedeemCode(q)}%`;
    const fuzzy = `%${String(q).trim().toLowerCase()}%`;
    params.push(search, fuzzy);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  // 只有关键词检索需要回表到 inventory 匹配 search_text，其余情况省掉这次 join。
  const inventoryJoin = q
    ? "LEFT JOIN redeem_inventory inventory ON inventory.id = records.inventory_id"
    : "";
  // 类型 / 卡密码筛选都要走 codes，没筛选条件时不必 join。
  const codesJoin = conditions.length
    ? "JOIN redeem_codes codes ON codes.id = records.code_id"
    : "";

  const totalRow = db
    .prepare(
      `
        SELECT COUNT(DISTINCT records.code_id) AS total
        FROM redeem_records records
        ${codesJoin}
        ${inventoryJoin}
        ${where}
      `,
    )
    .get(...params);

  const rows = db
    .prepare(
      `
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
        ${inventoryJoin}
        JOIN redeem_codes codes ON codes.id = records.code_id
        JOIN redeem_email_types types ON types.id = codes.type_id
        ${where}
        GROUP BY records.code_id
        ORDER BY MAX(records.id) DESC
        LIMIT ? OFFSET ?
      `,
    )
    .all(...params, safePageSize, Math.max(0, (safePage - 1) * safePageSize));

  return {
    items: rows.map(rowToRedeemRecordGroup),
    total: Number(totalRow?.total || 0),
    page: safePage,
    page_size: safePageSize,
  };
}

export function ensureAccountsLoaded() {
  if (shouldSeedDefaultRedeemType) {
    ensureDefaultRedeemEmailType();
  }
  return true;
}

export function closeDb() {
  db.close();
}
