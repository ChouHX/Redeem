import Database from "better-sqlite3";
import { DB_PATH, CLIENT_ID, DEFAULT_EMAIL_LIMIT } from "./config.js";
import {
  DEFAULT_REDEEM_EMAIL_TYPE,
  generateRedeemCode,
  normalizeRedeemCode,
  parseMailboxAccountLine,
  parseRedeemFieldSchema,
  payloadToSearchText,
  serializeInventoryPayload
} from "./redeem.js";

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

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
  import_delimiter TEXT NOT NULL DEFAULT '----',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS redeem_inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type_id INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  serialized_value TEXT NOT NULL,
  search_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'available',
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
  type_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  normalized_code TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  requester_ip TEXT DEFAULT '',
  requester_user_agent TEXT DEFAULT '',
  redeemed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email);
CREATE INDEX IF NOT EXISTS idx_account_tags_email ON account_tags(email);
CREATE INDEX IF NOT EXISTS idx_email_cache_email ON email_cache(email);
CREATE INDEX IF NOT EXISTS idx_redeem_types_active ON redeem_email_types(is_active);
CREATE INDEX IF NOT EXISTS idx_redeem_inventory_type_status ON redeem_inventory(type_id, status);
CREATE INDEX IF NOT EXISTS idx_redeem_inventory_search ON redeem_inventory(search_text);
CREATE INDEX IF NOT EXISTS idx_redeem_codes_type_status ON redeem_codes(type_id, status);
CREATE INDEX IF NOT EXISTS idx_redeem_codes_normalized_code ON redeem_codes(normalized_code);
CREATE INDEX IF NOT EXISTS idx_redeem_records_type_id ON redeem_records(type_id);
CREATE INDEX IF NOT EXISTS idx_redeem_records_code_id ON redeem_records(code_id);
`);

function ensureColumn(tableName, columnName, columnDefinition) {
  const exists = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .some((column) => column.name === columnName);

  if (!exists) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
  }
}

ensureColumn("redeem_codes", "quantity", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("redeem_codes", "redeemed_quantity", "INTEGER NOT NULL DEFAULT 0");

function rowToAccount(row) {
  return {
    password: row.password || "",
    client_id: row.client_id || "",
    refresh_token: row.refresh_token || ""
  };
}

function clampPositiveInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback;
  }

  return Math.min(parsed, max);
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
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
        FROM redeem_codes codes
        WHERE
          codes.type_id = t.id
          AND codes.status = 'unused'
          AND (codes.expires_at IS NULL OR codes.expires_at > CURRENT_TIMESTAMP)
      ) AS available_code_count,
      (
        SELECT COUNT(*)
        FROM redeem_records records
        WHERE records.type_id = t.id
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
    import_delimiter: row.import_delimiter || "----",
    is_active: Boolean(row.is_active),
    available_inventory_count: Number(row.available_inventory_count || 0),
    available_code_count: Number(row.available_code_count || 0),
    redeemed_count: Number(row.redeemed_count || 0),
    created_at: row.created_at || "",
    updated_at: row.updated_at || ""
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
    field_schema: row.field_schema ? parseRedeemFieldSchema(row.field_schema) : undefined,
    import_delimiter: row.import_delimiter || "----",
    payload: parseJson(row.payload_json, {}),
    serialized_value: row.serialized_value || "",
    search_text: row.search_text || "",
    status: row.status,
    redeemed_code_id: row.redeemed_code_id ?? null,
    redeemed_at: row.redeemed_at || null,
    created_at: row.created_at || "",
    updated_at: row.updated_at || ""
  };
}

function normalizeLookupValue(value) {
  return String(value || "").trim().toLowerCase();
}

function extractMailboxCredentials(payload = {}) {
  if (payload.raw_line) {
    const parsed = parseMailboxAccountLine(payload.raw_line, CLIENT_ID);
    if (parsed?.email && parsed?.refresh_token) {
      return parsed;
    }
  }

  const email = String(
    payload.account || payload.email || payload.mail || payload.username || ""
  ).trim();
  const refreshToken = String(
    payload.refreshtoken || payload.refresh_token || ""
  ).trim();

  if (!email || !refreshToken) {
    return null;
  }

  return {
    email,
    password: String(payload.password || "").trim(),
    client_id: String(payload.oauth2id || payload.client_id || CLIENT_ID).trim() || CLIENT_ID,
    refresh_token: refreshToken
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
        "(codes.expires_at IS NULL OR codes.expires_at > CURRENT_TIMESTAMP)"
      ],
      params: []
    };
  }

  if (nextStatus === "expired") {
    return {
      conditions: [
        "codes.status = 'unused'",
        "codes.expires_at IS NOT NULL",
        "codes.expires_at <= CURRENT_TIMESTAMP"
      ],
      params: []
    };
  }

  if (nextStatus === "unused" || nextStatus === "redeemed" || nextStatus === "disabled") {
    return {
      conditions: ["codes.status = ?"],
      params: [nextStatus]
    };
  }

  return {
    conditions: [],
    params: []
  };
}

function buildRedeemCodesWhere({
  type_id = "",
  status = "",
  q = "",
  min_quantity = "",
  max_quantity = ""
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
    params
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
    created_at: row.created_at || "",
    updated_at: row.updated_at || ""
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
    field_schema: row.field_schema ? parseRedeemFieldSchema(row.field_schema) : undefined,
    import_delimiter: row.import_delimiter || "----",
    payload: parseJson(row.payload_json, {}),
    requester_ip: row.requester_ip || "",
    requester_user_agent: row.requester_user_agent || "",
    redeemed_at: row.redeemed_at || ""
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
    item_count: Number(row.item_count || 0),
    redeemed_at: row.redeemed_at || "",
    requester_ip: row.requester_ip || "",
    requester_user_agent: row.requester_user_agent || ""
  };
}

function nowTimestamp() {
  return db.prepare("SELECT CURRENT_TIMESTAMP AS now").get().now;
}

export function getAccount(email) {
  const row = db
    .prepare("SELECT email, password, client_id, refresh_token FROM accounts WHERE email = ?")
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
          types.import_delimiter
        FROM redeem_inventory inventory
        JOIN redeem_email_types types ON types.id = inventory.type_id
        ORDER BY
          CASE inventory.status WHEN 'available' THEN 0 ELSE 1 END,
          inventory.updated_at DESC,
          inventory.id DESC
      `
    )
    .all();

  for (const row of rows) {
    const payload = parseJson(row.payload_json, {});
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
      payload: payload,
      field_schema: row.field_schema ? parseRedeemFieldSchema(row.field_schema) : undefined,
      import_delimiter: row.import_delimiter || "----"
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
          types.import_delimiter
        FROM redeem_inventory inventory
        JOIN redeem_email_types types ON types.id = inventory.type_id
        WHERE inventory.id = ?
        LIMIT 1
      `
    )
    .get(Number(inventoryId));

  if (!row) {
    return false;
  }

  const fieldSchema = row.field_schema ? parseRedeemFieldSchema(row.field_schema) : undefined;
  const delimiter = row.import_delimiter || "----";
  const serializedValue = serializeInventoryPayload(fieldSchema, payload, delimiter);
  const searchText = payloadToSearchText(payload) || serializedValue.toLowerCase();

  const result = db
    .prepare(
      `
        UPDATE redeem_inventory
        SET
          payload_json = ?,
          serialized_value = ?,
          search_text = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `
    )
    .run(JSON.stringify(payload), serializedValue, searchText, Number(inventoryId));

  return result.changes > 0;
}

export function upsertAccount({ email, password = "", client_id = "", refresh_token }) {
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
    email_limit: value ? Number(value.value) : DEFAULT_EMAIL_LIMIT
  };
}

export function getSystemConfigValue(key) {
  const row = db.prepare("SELECT value FROM system_config WHERE key = ?").get(String(key || ""));
  return row ? row.value : null;
}

export function setSystemConfigValue(key, value) {
  db.prepare(
    "INSERT INTO system_config (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP"
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
          import_delimiter,
          is_active,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `
    )
    .run(
      type.slug,
      type.name,
      type.description || "",
      JSON.stringify(type.field_schema),
      type.import_delimiter || "----",
      type.is_active ? 1 : 0
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
          import_delimiter = ?,
          is_active = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `
    )
    .run(
      type.slug,
      type.name,
      type.description || "",
      JSON.stringify(type.field_schema),
      type.import_delimiter || "----",
      type.is_active ? 1 : 0,
      Number(typeId)
    );

  return result.changes > 0 ? getRedeemEmailTypeById(typeId) : null;
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
      `
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
      `
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
    available_inventory_count: Number(inventory?.available_inventory_count || 0),
    unavailable_inventory_count: Number(inventory?.unavailable_inventory_count || 0),
    redeemed_inventory_count: Number(inventory?.redeemed_inventory_count || 0),
    total_code_count: Number(codes?.total_code_count || 0),
    unused_code_count: Number(codes?.unused_code_count || 0),
    redeemed_code_count: Number(codes?.redeemed_code_count || 0),
    disabled_code_count: Number(codes?.disabled_code_count || 0),
    record_count: Number(recordCount?.record_count || 0)
  };
}

export function getRedeemInventoryPaged({
  type_id = "",
  status = "",
  q = "",
  page = 1,
  page_size = 10
} = {}) {
  const safePage = clampPositiveInt(page, 1);
  const safePageSize = clampPositiveInt(page_size, 10, 100);
  const conditions = [];
  const params = [];

  if (type_id) {
    conditions.push("inventory.type_id = ?");
    params.push(Number(type_id));
  }

  if (status === "available" || status === "unavailable" || status === "redeemed") {
    conditions.push("inventory.status = ?");
    params.push(status);
  }

  if (q) {
    conditions.push("inventory.search_text LIKE ?");
    params.push(`%${String(q).trim().toLowerCase()}%`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const totalRow = db
    .prepare(
      `
        SELECT COUNT(*) AS total
        FROM redeem_inventory inventory
        ${where}
      `
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
          types.import_delimiter
        FROM redeem_inventory inventory
        JOIN redeem_email_types types ON types.id = inventory.type_id
        ${where}
        ORDER BY inventory.id DESC
        LIMIT ? OFFSET ?
      `
    )
    .all(...params, safePageSize, Math.max(0, (safePage - 1) * safePageSize));

  return {
    items: rows.map(rowToRedeemInventory),
    total: Number(totalRow?.total || 0),
    page: safePage,
    page_size: safePageSize
  };
}

export function importRedeemInventory({ type_id, items = [], mode = "append" }) {
  const type = getRedeemEmailTypeById(type_id);
  if (!type) {
    throw new Error("兑换类型不存在");
  }

  const normalizedMode = mode === "replace_available" ? "replace_available" : "append";
  const tx = db.transaction((targetType, nextItems, nextMode) => {
    let cleared = 0;
    let added = 0;
    let skipped = 0;

    if (nextMode === "replace_available") {
      cleared = db
        .prepare("DELETE FROM redeem_inventory WHERE type_id = ? AND status = 'available'")
        .run(targetType.id).changes;
    }

    const insertStmt = db.prepare(
      `
        INSERT OR IGNORE INTO redeem_inventory (
          type_id,
          payload_json,
          serialized_value,
          search_text,
          status,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, 'available', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `
    );

    for (const item of nextItems) {
      const payload = item.payload || {};
      const serializedValue =
        item.serialized_value ||
        serializeInventoryPayload(
          targetType.field_schema,
          payload,
          targetType.import_delimiter
        );
      const searchText = item.search_text || payloadToSearchText(payload);
      const result = insertStmt.run(
        targetType.id,
        JSON.stringify(payload),
        serializedValue,
        searchText
      );

      if (result.changes > 0) {
        added += 1;
      } else {
        skipped += 1;
      }
    }

    return {
      mode: nextMode,
      cleared_count: cleared,
      added_count: added,
      skipped_count: skipped,
      total_count: nextItems.length
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
          types.import_delimiter
        FROM redeem_inventory inventory
        JOIN redeem_email_types types ON types.id = inventory.type_id
        WHERE inventory.id = ?
        LIMIT 1
      `
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
      "UPDATE redeem_inventory SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(nextStatus, Number(inventoryId));
  }

  return rowToRedeemInventory({ ...row, status: nextStatus });
}

export function updateRedeemInventoryBatch(ids, { type_id = null, status = null } = {}) {
  const targets = [
    ...new Set(
      (ids || [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0)
    )
  ];
  const nextStatus =
    status === "available" || status === "unavailable" ? status : null;
  const nextTypeId =
    Number.isInteger(Number(type_id)) && Number(type_id) > 0 ? Number(type_id) : null;

  if (!nextStatus && !nextTypeId) {
    throw new Error("请至少指定一个库存修改项");
  }

  const nextType = nextTypeId ? getRedeemEmailTypeById(nextTypeId) : null;
  if (nextTypeId && !nextType) {
    throw new Error("兑换类型不存在");
  }

  const tx = db.transaction((items, targetStatus, targetType) => {
    let updatedCount = 0;
    let skippedCount = 0;
    const selectStmt = db.prepare(
      `
        SELECT
          inventory.*,
          types.name AS type_name,
          types.slug AS type_slug,
          types.field_schema,
          types.import_delimiter
        FROM redeem_inventory inventory
        JOIN redeem_email_types types ON types.id = inventory.type_id
        WHERE inventory.id = ?
        LIMIT 1
      `
    );
    const duplicateStmt = db.prepare(
      `
        SELECT id
        FROM redeem_inventory
        WHERE type_id = ? AND serialized_value = ? AND id != ?
        LIMIT 1
      `
    );
    const updateStmt = db.prepare(
      `
        UPDATE redeem_inventory
        SET
          type_id = ?,
          serialized_value = ?,
          search_text = ?,
          status = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `
    );

    for (const id of items) {
      const row = selectStmt.get(id);
      if (!row || row.status === "redeemed") {
        skippedCount += 1;
        continue;
      }

      const payload = parseJson(row.payload_json, {});
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
        finalDelimiter
      );
      const finalSearchText =
        payloadToSearchText(payload) || String(finalSerializedValue || "").trim().toLowerCase();
      const finalStatus = targetStatus || row.status;

      if (
        finalTypeId === row.type_id &&
        finalSerializedValue === row.serialized_value &&
        finalSearchText === (row.search_text || "") &&
        finalStatus === row.status
      ) {
        skippedCount += 1;
        continue;
      }

      if (duplicateStmt.get(finalTypeId, finalSerializedValue, id)) {
        skippedCount += 1;
        continue;
      }

      updatedCount += updateStmt.run(
        finalTypeId,
        finalSerializedValue,
        finalSearchText,
        finalStatus,
        id
      ).changes;
    }

    return {
      updated_count: updatedCount,
      skipped_count: skippedCount,
      total_count: items.length,
      status: targetStatus,
      type_id: targetType ? targetType.id : null
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
  const targets = [...new Set((ids || []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  const tx = db.transaction((items) => {
    let deleted = 0;
    const stmt = db.prepare("DELETE FROM redeem_inventory WHERE id = ?");
    for (const id of items) {
      deleted += stmt.run(id).changes;
    }
    return deleted;
  });
  return tx(targets);
}

export function getRedeemInventoryByIds(ids) {
  const targets = [...new Set((ids || []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  if (!targets.length) {
    return [];
  }

  const placeholders = targets.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `
        SELECT
          inventory.*,
          types.name AS type_name,
          types.slug AS type_slug,
          types.field_schema,
          types.import_delimiter
        FROM redeem_inventory inventory
        JOIN redeem_email_types types ON types.id = inventory.type_id
        WHERE inventory.id IN (${placeholders})
        ORDER BY inventory.id ASC
      `
    )
    .all(...targets);

  return rows.map(rowToRedeemInventory);
}

export function getRedeemCodesPaged({
  type_id = "",
  status = "",
  q = "",
  min_quantity = "",
  max_quantity = "",
  page = 1,
  page_size = 10
} = {}) {
  const safePage = clampPositiveInt(page, 1);
  const safePageSize = clampPositiveInt(page_size, 10, 100);
  const { where, params } = buildRedeemCodesWhere({
    type_id,
    status,
    q,
    min_quantity,
    max_quantity
  });
  const totalRow = db
    .prepare(
      `
        SELECT COUNT(*) AS total
        FROM redeem_codes codes
        ${where}
      `
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
        JOIN redeem_email_types types ON types.id = codes.type_id
        ${where}
        ORDER BY codes.id DESC
        LIMIT ? OFFSET ?
      `
    )
    .all(...params, safePageSize, Math.max(0, (safePage - 1) * safePageSize));

  return {
    items: rows.map(rowToRedeemCode),
    total: Number(totalRow?.total || 0),
    page: safePage,
    page_size: safePageSize
  };
}

export function getRedeemCodesByIds(ids) {
  const targets = [...new Set((ids || []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  if (!targets.length) {
    return [];
  }

  const placeholders = targets.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `
        SELECT
          codes.*,
          types.name AS type_name,
          types.slug AS type_slug
        FROM redeem_codes codes
        JOIN redeem_email_types types ON types.id = codes.type_id
        WHERE codes.id IN (${placeholders})
        ORDER BY codes.id ASC
      `
    )
    .all(...targets);

  return rows.map(rowToRedeemCode);
}

export function getRedeemCodesForExport({
  type_id = "",
  status = "",
  q = "",
  min_quantity = "",
  max_quantity = ""
} = {}) {
  const { where, params } = buildRedeemCodesWhere({
    type_id,
    status,
    q,
    min_quantity,
    max_quantity
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
      `
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
      `
    )
    .get(normalizedCode);

  return rowToRedeemCode(row);
}

export function getRedeemRecordsByCodeId(codeId) {
  const rows = db
    .prepare(
      `
        SELECT
          records.*,
          types.name AS type_name,
          types.slug AS type_slug,
          types.field_schema,
          types.import_delimiter
        FROM redeem_records records
        JOIN redeem_email_types types ON types.id = records.type_id
        WHERE records.code_id = ?
        ORDER BY records.id ASC
      `
    )
    .all(Number(codeId));

  return rows.map(rowToRedeemRecord);
}

export function getRedeemRecordsByCodeIdPaged(codeId, { page = 1, page_size = 10 } = {}) {
  const safeCodeId = Number(codeId);
  const safePage = clampPositiveInt(page, 1);
  const safePageSize = clampPositiveInt(page_size, 10, 100);
  const totalRow = db
    .prepare(
      `
        SELECT COUNT(*) AS total
        FROM redeem_records
        WHERE code_id = ?
      `
    )
    .get(safeCodeId);

  const rows = db
    .prepare(
      `
        SELECT
          records.*,
          types.name AS type_name,
          types.slug AS type_slug,
          types.field_schema,
          types.import_delimiter
        FROM redeem_records records
        JOIN redeem_email_types types ON types.id = records.type_id
        WHERE records.code_id = ?
        ORDER BY records.id ASC
        LIMIT ? OFFSET ?
      `
    )
    .all(safeCodeId, safePageSize, Math.max(0, (safePage - 1) * safePageSize));

  return {
    items: rows.map(rowToRedeemRecord),
    total: Number(totalRow?.total || 0),
    page: safePage,
    page_size: safePageSize
  };
}

export function createRedeemCodes({
  type_id,
  count = 1,
  quantity = 1,
  note = "",
  expires_at = null
}) {
  const type = getRedeemEmailTypeById(type_id);
  if (!type) {
    throw new Error("兑换类型不存在");
  }

  const safeCount = clampPositiveInt(count, 1, 500);
  const safeQuantity = clampPositiveInt(quantity, 1, 500);
  const tx = db.transaction((targetType, amount, nextQuantity, nextNote, nextExpiresAt) => {
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
      `
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
            nextExpiresAt
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
              updated_at: nowTimestamp()
            })
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
  });

  return tx(
    type,
    safeCount,
    safeQuantity,
    String(note || "").trim(),
    expires_at || null
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
      `
    )
    .get(Number(codeId));

  if (!row) {
    return null;
  }

  if (row.status === "redeemed") {
    throw new Error("已兑换的卡密不能修改状态");
  }

  db.prepare(
    "UPDATE redeem_codes SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(nextStatus, Number(codeId));

  return rowToRedeemCode({ ...row, status: nextStatus });
}

export function updateRedeemCodeBatch(ids, { type_id = null, quantity = null } = {}) {
  const targets = [
    ...new Set(
      (ids || [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0)
    )
  ];
  const nextTypeId =
    Number.isInteger(Number(type_id)) && Number(type_id) > 0 ? Number(type_id) : null;
  const nextQuantity =
    Number.isInteger(Number(quantity)) && Number(quantity) > 0 ? Number(quantity) : null;

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
    const selectStmt = db.prepare(
      `
        SELECT
          codes.*,
          types.name AS type_name,
          types.slug AS type_slug
        FROM redeem_codes codes
        JOIN redeem_email_types types ON types.id = codes.type_id
        WHERE codes.id = ?
        LIMIT 1
      `
    );
    const updateStmt = db.prepare(
      `
        UPDATE redeem_codes
        SET
          type_id = ?,
          quantity = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `
    );

    for (const id of items) {
      const row = selectStmt.get(id);
      if (!row || row.status === "redeemed") {
        skippedCount += 1;
        continue;
      }

      const finalTypeId = targetType ? targetType.id : row.type_id;
      const finalQuantity = targetQuantity || Math.max(1, Number(row.quantity || 1));

      if (finalTypeId === row.type_id && finalQuantity === Number(row.quantity || 1)) {
        skippedCount += 1;
        continue;
      }

      updatedCount += updateStmt.run(finalTypeId, finalQuantity, id).changes;
    }

    return {
      updated_count: updatedCount,
      skipped_count: skippedCount,
      total_count: items.length,
      type_id: targetType ? targetType.id : null,
      quantity: targetQuantity
    };
  });

  return tx(targets, nextType, nextQuantity);
}

export function updateRedeemCodeStatusBatch(ids, status) {
  const nextStatus = status === "disabled" ? "disabled" : "unused";
  const targets = [...new Set((ids || []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];

  const tx = db.transaction((items, targetStatus) => {
    let updatedCount = 0;
    let skippedCount = 0;
    const selectStmt = db.prepare("SELECT id, status FROM redeem_codes WHERE id = ? LIMIT 1");
    const updateStmt = db.prepare(
      "UPDATE redeem_codes SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    );

    for (const id of items) {
      const row = selectStmt.get(id);
      if (!row || row.status === "redeemed" || row.status === targetStatus) {
        skippedCount += 1;
        continue;
      }

      updatedCount += updateStmt.run(targetStatus, id).changes;
    }

    return {
      updated_count: updatedCount,
      skipped_count: skippedCount,
      total_count: items.length,
      status: targetStatus
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

  const result = db.prepare("DELETE FROM redeem_codes WHERE id = ?").run(targetId);
  return result.changes > 0;
}

export function deleteRedeemCodeBatch(ids) {
  const targets = [
    ...new Set(
      (ids || [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0)
    )
  ];
  const tx = db.transaction((items) => {
    let deletedCount = 0;
    let skippedCount = 0;
    const selectStmt = db.prepare(
      "SELECT id, status FROM redeem_codes WHERE id = ? LIMIT 1"
    );
    const deleteStmt = db.prepare("DELETE FROM redeem_codes WHERE id = ?");

    for (const id of items) {
      const row = selectStmt.get(id);
      if (!row || row.status === "redeemed") {
        skippedCount += 1;
        continue;
      }

      deletedCount += deleteStmt.run(id).changes;
    }

    return {
      deleted_count: deletedCount,
      skipped_count: skippedCount,
      total_count: items.length
    };
  });

  return tx(targets);
}

export function redeemByCode({
  code,
  requester_ip = "",
  requester_user_agent = ""
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
            types.import_delimiter,
            types.description
          FROM redeem_codes codes
          JOIN redeem_email_types types ON types.id = codes.type_id
          WHERE codes.normalized_code = ?
          LIMIT 1
        `
      )
      .get(targetCode);

    if (!codeRow) {
      throw new Error("兑换码不存在");
    }

    if (codeRow.status === "disabled") {
      throw new Error("兑换码已禁用");
    }

    if (codeRow.status === "redeemed") {
      throw new Error("兑换码已被使用");
    }

    if (codeRow.expires_at && Date.parse(codeRow.expires_at) <= Date.now()) {
      throw new Error("兑换码已过期");
    }

    const quantity = Math.max(1, Number(codeRow.quantity || 1));
    const inventoryRows = db
      .prepare(
        `
          SELECT *
          FROM redeem_inventory
          WHERE type_id = ? AND status = 'available'
          ORDER BY id ASC
          LIMIT ?
        `
      )
      .all(codeRow.type_id, quantity);

    if (inventoryRows.length < quantity) {
      throw new Error(`当前类型库存不足，至少需要 ${quantity} 份可用库存`);
    }

    const redeemedAt = nowTimestamp();
    const updateInventoryStmt = db.prepare(
      `
        UPDATE redeem_inventory
        SET
          status = 'redeemed',
          redeemed_code_id = ?,
          redeemed_at = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'available'
      `
    );
    const insertRecordStmt = db.prepare(
      `
        INSERT INTO redeem_records (
          code_id,
          inventory_id,
          type_id,
          code,
          normalized_code,
          payload_json,
          requester_ip,
          requester_user_agent,
          redeemed_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    );
    const inventories = [];
    const recordIds = [];

    for (const inventoryRow of inventoryRows) {
      const inventoryUpdate = updateInventoryStmt.run(codeRow.id, redeemedAt, inventoryRow.id);

      if (!inventoryUpdate.changes) {
        throw new Error("库存领取失败，请稍后重试");
      }

      const recordResult = insertRecordStmt.run(
        codeRow.id,
        inventoryRow.id,
        codeRow.type_id,
        codeRow.code,
        codeRow.normalized_code,
        inventoryRow.payload_json,
        requesterIp,
        requesterUserAgent,
        redeemedAt
      );

      recordIds.push(Number(recordResult.lastInsertRowid));
      inventories.push(
        rowToRedeemInventory({
          ...inventoryRow,
          type_name: codeRow.type_name,
          type_slug: codeRow.type_slug,
          field_schema: codeRow.field_schema,
          import_delimiter: codeRow.import_delimiter,
          status: "redeemed",
          redeemed_code_id: codeRow.id,
          redeemed_at: redeemedAt
        })
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
        `
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
        redeemed_at: redeemedAt
      }),
      inventories,
      type: rowToRedeemType({
        id: codeRow.type_id,
        slug: codeRow.type_slug,
        name: codeRow.type_name,
        description: codeRow.description,
        field_schema: codeRow.field_schema,
        import_delimiter: codeRow.import_delimiter,
        is_active: 1,
        available_inventory_count: 0,
        available_code_count: 0,
        redeemed_count: 0,
        created_at: "",
        updated_at: ""
      })
    };
  });

  return tx(
    normalizedCode,
    String(requester_ip || "").trim(),
    String(requester_user_agent || "").trim()
  );
}

export function getRedeemRecordsPaged({
  type_id = "",
  q = "",
  page = 1,
  page_size = 10
} = {}) {
  const safePage = clampPositiveInt(page, 1);
  const safePageSize = clampPositiveInt(page_size, 10, 100);
  const conditions = [];
  const params = [];

  if (type_id) {
    conditions.push("records.type_id = ?");
    params.push(Number(type_id));
  }

  if (q) {
    conditions.push("(records.normalized_code LIKE ? OR inventory.search_text LIKE ?)");
    const search = `%${normalizeRedeemCode(q)}%`;
    const fuzzy = `%${String(q).trim().toLowerCase()}%`;
    params.push(search, fuzzy);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const totalRow = db
    .prepare(
      `
        SELECT COUNT(DISTINCT records.code_id) AS total
        FROM redeem_records records
        LEFT JOIN redeem_inventory inventory ON inventory.id = records.inventory_id
        ${where}
      `
    )
    .get(...params);

  const rows = db
    .prepare(
      `
        SELECT
          records.code_id,
          records.type_id,
          records.code,
          records.normalized_code,
          types.name AS type_name,
          types.slug AS type_slug,
          COUNT(records.id) AS item_count,
          MAX(records.redeemed_at) AS redeemed_at,
          MAX(records.requester_ip) AS requester_ip,
          MAX(records.requester_user_agent) AS requester_user_agent
        FROM redeem_records records
        JOIN redeem_email_types types ON types.id = records.type_id
        LEFT JOIN redeem_inventory inventory ON inventory.id = records.inventory_id
        ${where}
        GROUP BY
          records.code_id,
          records.type_id,
          records.code,
          records.normalized_code,
          types.name,
          types.slug
        ORDER BY MAX(records.id) DESC
        LIMIT ? OFFSET ?
      `
    )
    .all(...params, safePageSize, Math.max(0, (safePage - 1) * safePageSize));

  return {
    items: rows.map(rowToRedeemRecordGroup),
    total: Number(totalRow?.total || 0),
    page: safePage,
    page_size: safePageSize
  };
}

export function ensureAccountsLoaded() {
  ensureDefaultRedeemEmailType();
  return true;
}

export function closeDb() {
  db.close();
}
