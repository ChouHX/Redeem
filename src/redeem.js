const RAW_LINE_FIELD_SCHEMA = [
  {
    key: "raw_line",
    label: "原始数据",
    required: true,
    sensitive: false,
    placeholder: "整行数据"
  }
];

const DEFAULT_FIELD_SCHEMA = [
  {
    key: "account",
    label: "账号",
    required: true,
    sensitive: false,
    placeholder: "邮箱账号"
  },
  {
    key: "password",
    label: "密码",
    required: false,
    sensitive: true,
    placeholder: "登录密码"
  },
  {
    key: "oauth2id",
    label: "OAuth2 ID",
    required: false,
    sensitive: false,
    placeholder: "OAuth2 Client ID"
  },
  {
    key: "refreshtoken",
    label: "Refresh Token",
    required: true,
    sensitive: true,
    placeholder: "Refresh Token"
  }
];

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const MAIL_PROTOCOLS = ["imap", "graph"];

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function toBoolean(value, fallback = true) {
  if (typeof value === "boolean") {
    return value;
  }

  if (value === 0 || value === "0" || value === "false") {
    return false;
  }

  if (value === 1 || value === "1" || value === "true") {
    return true;
  }

  return fallback;
}

export function normalizeMailProtocol(value, fallback = "imap") {
  const normalized = String(value || fallback || "imap").trim().toLowerCase();
  return MAIL_PROTOCOLS.includes(normalized) ? normalized : "imap";
}

export function normalizeMailProtocols(value, fallback = ["imap"]) {
  let values = value;
  if (typeof values === "string") {
    try {
      const parsed = JSON.parse(values);
      values = Array.isArray(parsed) ? parsed : [values];
    } catch {
      values = values.split(",");
    }
  }

  const normalized = [...new Set((Array.isArray(values) ? values : []).map((item) =>
    String(item || "").trim().toLowerCase()
  ).filter((item) => MAIL_PROTOCOLS.includes(item)))];
  if (normalized.length) return normalized;
  const fallbackValues = Array.isArray(fallback) ? fallback : [fallback];
  return [...new Set(fallbackValues.map((item) => normalizeMailProtocol(item)))];
}

export function collectRedeemedMailProtocols(inventories = [], type = {}) {
  const typeProtocols = normalizeMailProtocols(type?.mail_protocols, [
    type?.mail_protocol || "imap",
  ]);

  return normalizeMailProtocols(
    (Array.isArray(inventories) ? inventories : []).flatMap((inventory) =>
      normalizeMailProtocols(inventory?.mail_protocols, []),
    ),
    typeProtocols,
  );
}

// IMAP 与 Graph 取件共用同一套 OAuth 凭据（client_id + refresh token），
// 因此只要账号本身带着完整 OAuth 凭据，两种协议在能力上都是可用的。
export function inferPickupProtocolsFromPayload(payload = {}) {
  const rawLine = String(payload?.raw_line || "").trim();
  if (rawLine) {
    const parts = rawLine.split("----").map((item) => item.trim());
    if (parts.length >= 4 && parts[2] && parts[3]) {
      return ["imap", "graph"];
    }
    return [];
  }

  const clientId = String(payload?.oauth2id || payload?.client_id || "").trim();
  const refreshToken = String(
    payload?.refreshtoken || payload?.refresh_token || "",
  ).trim();

  return clientId && refreshToken ? ["imap", "graph"] : [];
}

// 账号可用的取件协议 = 类型允许范围 ∩ (入库元数据 ∪ 账号凭据能力)。
// 返回给用户端的协议一律走这里，保证「兑换结果」与「取件页」看到的
// 是同一份账号级协议，且类型级协议永远只是上限、不会被当成账号能力。
export function resolvePickupProtocols({
  type = {},
  payload = {},
  storedProtocols = [],
} = {}) {
  const allowed = normalizeMailProtocols(type?.mail_protocols, [
    type?.mail_protocol || "imap",
  ]);
  const stored = normalizeMailProtocols(storedProtocols, []);
  const capable = normalizeMailProtocols(
    inferPickupProtocolsFromPayload(payload),
    [],
  );

  const resolved = [...new Set([...stored, ...capable])].filter((protocol) =>
    allowed.includes(protocol),
  );

  return resolved.length ? resolved : allowed;
}

// 结果条目只保留取件端真正需要的三样东西：账号级协议、输出行、结构化字段。
export function formatRedeemResultItem(
  type = {},
  payload = {},
  storedProtocols = [],
) {
  const fieldSchema = parseRedeemFieldSchema(type?.field_schema || DEFAULT_FIELD_SCHEMA);
  const delimiter = String(type?.import_delimiter || "----");
  const normalizedPayload = normalizeInventoryPayload(fieldSchema, payload);

  return {
    mail_protocols: resolvePickupProtocols({
      type,
      payload: normalizedPayload,
      storedProtocols,
    }),
    formatted_line: serializeInventoryPayload(
      fieldSchema,
      normalizedPayload,
      delimiter,
    ),
    payload: normalizedPayload,
  };
}

// 类型信息只保留标识与展示文案，协议字段语义为「该类型允许的范围」。
export function formatRedeemResultType(type = {}) {
  const mailProtocols = normalizeMailProtocols(type?.mail_protocols, [
    type?.mail_protocol || "imap",
  ]);

  return {
    id: type?.id ?? null,
    slug: type?.slug || "",
    name: type?.name || "",
    description: type?.description || "",
    import_delimiter: String(type?.import_delimiter || "----"),
    mail_protocol: mailProtocols[0],
    mail_protocols: mailProtocols,
  };
}

export function collectResultMailProtocols(items = [], type = {}) {
  return collectRedeemedMailProtocols(
    (Array.isArray(items) ? items : []).map((item) => ({
      mail_protocols: item?.mail_protocols,
    })),
    type,
  );
}

function normalizeFieldKey(value, index) {
  const fallbackKey = `field_${index + 1}`;
  const normalized = String(value || fallbackKey)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return normalized || fallbackKey;
}

export const DEFAULT_REDEEM_EMAIL_TYPE = {
  slug: "outlook-oauth",
  name: "Outlook OAuth 邮箱",
  description: "默认邮箱兑换类型，按整行数据保存，兼容 Outlook OAuth 四段配置。",
  mail_protocol: "imap",
  mail_protocols: ["imap"],
  import_delimiter: "----",
  is_active: true,
  field_schema: RAW_LINE_FIELD_SCHEMA
};

export function parseRedeemFieldSchema(rawSchema) {
  const schema = Array.isArray(rawSchema)
    ? rawSchema
    : safeJsonParse(rawSchema, DEFAULT_FIELD_SCHEMA);

  return normalizeRedeemFieldSchema(schema);
}

export function normalizeRedeemFieldSchema(rawSchema) {
  const list = Array.isArray(rawSchema) ? rawSchema : [];
  if (!list.length) {
    throw new Error("请至少配置一个字段");
  }

  const keys = new Set();
  const normalized = list.map((field, index) => {
    const key = normalizeFieldKey(field?.key, index);
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) {
      throw new Error(`字段键名不合法: ${field?.key || key}`);
    }

    if (keys.has(key)) {
      throw new Error(`字段键名重复: ${key}`);
    }
    keys.add(key);

    const label = String(field?.label || field?.name || key).trim();
    if (!label) {
      throw new Error(`字段 ${key} 缺少显示名称`);
    }

    return {
      key,
      label,
      required: toBoolean(field?.required, true),
      sensitive: toBoolean(field?.sensitive, false),
      placeholder: String(field?.placeholder || "").trim()
    };
  });

  return normalized;
}

export function normalizeRedeemEmailTypeInput(payload = {}, options = {}) {
  const name = String(payload.name || "").trim();
  if (!name) {
    throw new Error("类型名称不能为空");
  }

  const slug = slugify(payload.slug || name || options.slug || "");
  if (!slug) {
    throw new Error("类型标识不能为空");
  }

  const field_schema = normalizeRedeemFieldSchema(payload.field_schema || RAW_LINE_FIELD_SCHEMA);
  const import_delimiter = String(payload.import_delimiter || "----").trim() || "----";

  return {
    name,
    slug,
    description: String(payload.description || "").trim(),
    mail_protocols: normalizeMailProtocols(payload.mail_protocols, [payload.mail_protocol || "imap"]),
    mail_protocol: normalizeMailProtocols(payload.mail_protocols, [payload.mail_protocol || "imap"])[0],
    field_schema,
    import_delimiter,
    is_active: toBoolean(payload.is_active, true)
  };
}

export function normalizeRedeemCode(code) {
  return String(code || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

function isRawLineSchema(fields) {
  return Array.isArray(fields) && fields.length === 1 && fields[0]?.key === "raw_line";
}

function randomChunk(length = 4) {
  let output = "";
  for (let index = 0; index < length; index += 1) {
    const randomIndex = Math.floor(Math.random() * CODE_ALPHABET.length);
    output += CODE_ALPHABET[randomIndex];
  }
  return output;
}

export function generateRedeemCode() {
  const parts = [randomChunk(4), randomChunk(4), randomChunk(4)];
  return parts.join("-");
}

export function payloadToSearchText(payload = {}) {
  return Object.values(payload)
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean)
    .join(" ");
}

export function serializeInventoryPayload(fieldSchema, payload, delimiter = "----") {
  const fields = parseRedeemFieldSchema(fieldSchema);
  if (isRawLineSchema(fields)) {
    return String(payload?.raw_line || "").trim();
  }
  const separator = String(delimiter || "----");

  return fields.map((field) => String(payload?.[field.key] || "").trim()).join(separator);
}

export function normalizeInventoryPayload(fieldSchema, payload = {}) {
  const fields = parseRedeemFieldSchema(fieldSchema);
  if (isRawLineSchema(fields)) {
    const rawLine = String(payload?.raw_line || payload?.line || "").trim();
    if (!rawLine) {
      throw new Error("整行数据不能为空");
    }

    return {
      raw_line: rawLine
    };
  }
  const normalizedPayload = {};

  for (const field of fields) {
    const value = String(payload?.[field.key] || "").trim();
    if (field.required && !value) {
      throw new Error(`字段 ${field.label} 为必填项`);
    }
    normalizedPayload[field.key] = value;
  }

  return normalizedPayload;
}

export function parseInventoryImportText({ text, field_schema, import_delimiter = "----" }) {
  const fields = parseRedeemFieldSchema(field_schema);
  const delimiter = String(import_delimiter || "----");
  const items = [];
  const errors = [];

  for (const [index, rawLine] of String(text || "").split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    if (isRawLineSchema(fields)) {
      items.push({
        payload: { raw_line: line },
        serialized_value: line,
        search_text: line.toLowerCase()
      });
      continue;
    }

    const parts = line.split(delimiter).map((item) => item.trim());
    if (parts.length < fields.length) {
      errors.push(`第 ${index + 1} 行字段数量不足，期望 ${fields.length} 个字段`);
      continue;
    }

    const payload = {};
    for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex += 1) {
      const field = fields[fieldIndex];
      const value =
        fieldIndex === fields.length - 1
          ? parts.slice(fieldIndex).join(delimiter).trim()
          : String(parts[fieldIndex] || "").trim();

      payload[field.key] = value;
    }

    try {
      const normalizedPayload = normalizeInventoryPayload(fields, payload);
      items.push({
        payload: normalizedPayload,
        serialized_value: serializeInventoryPayload(fields, normalizedPayload, delimiter),
        search_text: payloadToSearchText(normalizedPayload)
      });
    } catch (error) {
      errors.push(`第 ${index + 1} 行格式错误: ${error.message}`);
    }
  }

  return {
    items,
    parsed_count: items.length,
    error_count: errors.length,
    errors
  };
}

export function formatRedeemedInventory(type, payload = {}) {
  const fieldSchema = parseRedeemFieldSchema(type?.field_schema || DEFAULT_FIELD_SCHEMA);
  const delimiter = String(type?.import_delimiter || "----");
  const normalizedPayload = normalizeInventoryPayload(fieldSchema, payload);
  const formattedLine = serializeInventoryPayload(fieldSchema, normalizedPayload, delimiter);
  const mailProtocols = normalizeMailProtocols(type?.mail_protocols, [
    type?.mail_protocol || "imap",
  ]);

  return {
    mail_protocols: mailProtocols,
    type: {
      id: type?.id ?? null,
      slug: type?.slug || "",
      name: type?.name || "",
      description: type?.description || "",
      mail_protocol: mailProtocols[0],
      mail_protocols: mailProtocols,
      import_delimiter: delimiter
    },
    fields: fieldSchema.map((field) => ({
      key: field.key,
      label: field.label,
      required: field.required,
      sensitive: field.sensitive,
      value: normalizedPayload[field.key] || ""
    })),
    payload: normalizedPayload,
    formatted_line: formattedLine
  };
}

export function parseMailboxAccountLine(rawLine, fallbackClientId = "") {
  const text = String(rawLine || "").trim();
  if (!text.includes("----")) {
    return null;
  }

  const parts = text.split("----").map((item) => item.trim());
  if (parts.length < 2) {
    return null;
  }

  if (parts.length >= 4) {
    return {
      email: parts[0],
      password: parts[1],
      client_id: parts[2] || fallbackClientId || "",
      refresh_token: parts.slice(3).join("----")
    };
  }

  return {
    email: parts[0],
    password: "",
    client_id: fallbackClientId || "",
    refresh_token: parts.slice(1).join("----")
  };
}
