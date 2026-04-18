import fs from "node:fs";
import path from "node:path";
import express from "express";
import cors from "cors";
import multer from "multer";
import {
  ADMIN_PATH,
  CLIENT_ID,
  DEFAULT_EMAIL_LIMIT,
  FRONTEND_DIST_DIR,
  HOST,
  PORT
} from "./config.js";
import {
  closeDb,
  createRedeemCodes,
  createRedeemEmailType,
  deleteRedeemCode,
  deleteRedeemCodeBatch,
  deleteRedeemInventory,
  deleteRedeemInventoryBatch,
  ensureAccountsLoaded,
  getRedeemCodeByCode,
  getRedeemCodesByIds,
  getRedeemCodesForExport,
  getRedeemRecordsByCodeId,
  getRedeemRecordsByCodeIdPaged,
  getMailboxAccountFromInventory,
  getRedeemAdminOverview,
  getRedeemCodesPaged,
  getRedeemEmailTypeById,
  getRedeemEmailTypes,
  getRedeemInventoryByIds,
  getRedeemInventoryPaged,
  getRedeemRecordsPaged,
  getSystemConfig,
  getSystemConfigValue,
  importRedeemInventory,
  redeemByCode,
  setSystemConfigValue,
  updateRedeemCodeBatch,
  updateRedeemCodeStatusBatch,
  updateRedeemCodeStatus,
  updateRedeemEmailType,
  updateRedeemInventoryBatch,
  updateRedeemInventoryStatus,
  updateRedeemInventoryPayload
} from "./db.js";
import { getAdminToken, requireAdmin, verifyAdminToken } from "./auth.js";
import {
  getMailMessageDetail,
  getMailMessagesPaged,
  getMessagesWithContent
} from "./imap.js";
import {
  parseMailboxAccountLine,
  formatRedeemedInventory,
  normalizeRedeemEmailTypeInput,
  parseInventoryImportText
} from "./redeem.js";
import {
  fail,
  formatDateTime,
  normalizeEmail,
  ok
} from "./utils.js";
import { createLogger } from "./logger.js";

const app = express();
const logger = createLogger("server");
const frontendIndexPath = path.join(FRONTEND_DIST_DIR, "index.html");
const hasFrontendIndex = fs.existsSync(frontendIndexPath);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 16 * 1024 * 1024
  }
});
const DEFAULT_AD_SLOT = {
  enabled: true,
  title: "自营发卡推荐",
  description:
    "本站同步提供多类数字商品，可直接前往发卡网下单。",
  items: ["ChatGPT Plus 月卡", "Gemini 年卡", "Team 车位", "Outlook 邮箱"],
  ticker_text:
    "自营发卡推荐：ChatGPT Plus 月卡、Gemini 年卡、Team 车位、Outlook 邮箱",
  image_url: "",
  image_alt: "广告图",
  primary_action: {
    label: "进入发卡网",
    href: "#"
  }
};
const DEFAULT_FAQ_HTML = `
<h2>使用须知</h2>
<ol>
  <li><strong>严禁利用本站购买的账号用于一切非法用途。</strong> 本站只有义务出售，但无法管控使用权。您拥有使用权以后，请务必合法利用，切勿游走法律边缘。</li>
  <li><strong>本站所出售的邮箱主要用于注册接收邮件。</strong> 禁止用于诈骗信息推广、违规信息推广以及其他非法用途。</li>
  <li><strong>一旦本站发现用于非法用途，除封号外，本站将全力配合有关部门予以打击。</strong></li>
  <li>邮箱如果收不到邮件，请先使用 <strong>IMAP 取件激活</strong> 一下。</li>
</ol>
<h2>Outlook 登录绕过辅助邮箱绑定</h2>
<p>已触发 7 天的号，如果登录网页提示绑定辅助邮箱，可在绑定提示页面保持不关闭，直接在原页面地址栏粘贴以下链接进入邮箱：</p>
<p><a href="https://outlook.live.com/mail/0/" target="_blank" rel="noreferrer">https://outlook.live.com/mail/0/</a></p>
`.trim();

app.use(cors());
app.use(express.json({ limit: "4mb" }));

ensureAccountsLoaded();

function parseBoundedInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}

function parseBoolean(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }

  if (value === "true" || value === "1" || value === 1) {
    return true;
  }

  if (value === "false" || value === "0" || value === 0) {
    return false;
  }

  return fallback;
}

function normalizeAdAction(value, fallback = { label: "", href: "" }) {
  const label = String(value?.label || fallback.label || "").trim();
  const href = String(value?.href || fallback.href || "").trim();
  return { label, href };
}

function normalizeAdSlotValue(value, fallback) {
  return {
    enabled: parseBoolean(value?.enabled, Boolean(fallback.enabled)),
    title: String(value?.title || fallback.title || "").trim(),
    description: String(value?.description || fallback.description || "").trim(),
    ticker_text: String(value?.ticker_text || fallback.ticker_text || "").trim(),
    image_url: String(value?.image_url || fallback.image_url || "").trim(),
    image_alt: String(value?.image_alt || fallback.image_alt || "").trim(),
    items: Array.isArray(value?.items)
      ? value.items
          .map((item) => String(item || "").trim())
          .filter(Boolean)
          .slice(0, 6)
      : Array.isArray(value?.highlights)
        ? value.highlights
            .map((item) => String(item || "").trim())
            .filter(Boolean)
            .slice(0, 6)
        : fallback.items,
    primary_action: normalizeAdAction(value?.primary_action, fallback.primary_action),
  };
}

function normalizeSharedAdSlotValue(value) {
  if (value?.shared) {
    return normalizeAdSlotValue(value.shared, DEFAULT_AD_SLOT);
  }

  if (value?.redeem_top || value?.mail_top) {
    return normalizeAdSlotValue(
      value.redeem_top || value.mail_top,
      DEFAULT_AD_SLOT
    );
  }

  return normalizeAdSlotValue(value, DEFAULT_AD_SLOT);
}

function getAdSlotConfig() {
  const rawValue =
    getSystemConfigValue("ad_slot") || getSystemConfigValue("ad_slots");
  if (!rawValue) {
    return normalizeSharedAdSlotValue(DEFAULT_AD_SLOT);
  }

  try {
    return normalizeSharedAdSlotValue(JSON.parse(rawValue));
  } catch {
    return normalizeSharedAdSlotValue(DEFAULT_AD_SLOT);
  }
}

function saveAdSlotConfig(value) {
  const normalized = normalizeSharedAdSlotValue(value);
  setSystemConfigValue("ad_slot", JSON.stringify(normalized));
  return normalized;
}

function getFaqHtml() {
  const rawValue = getSystemConfigValue("faq_html");
  return String(rawValue || DEFAULT_FAQ_HTML).trim();
}

function saveFaqHtml(value) {
  const normalized = String(value || "").trim() || DEFAULT_FAQ_HTML;
  setSystemConfigValue("faq_html", normalized);
  return normalized;
}

function sendFrontendIndex(res) {
  if (hasFrontendIndex) {
    res.sendFile(frontendIndexPath);
    return;
  }

  res
    .status(503)
    .type("text/html; charset=utf-8")
    .send(
      [
        "<!doctype html>",
        "<html lang=\"zh-CN\">",
        "<head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>前端尚未构建</title></head>",
        "<body style=\"font-family: sans-serif; padding: 32px; line-height: 1.7;\">",
        "<h1>前端尚未构建</h1>",
        "<p>请先在项目根目录执行 <code>npm --prefix ui run build</code>，然后刷新页面。</p>",
        "</body></html>"
      ].join("")
    );
}


function serializeRedeemTypeForPublic(type) {
  return {
    id: type.id,
    slug: type.slug,
    name: type.name,
    description: type.description,
    import_delimiter: type.import_delimiter,
    is_active: type.is_active,
    available_inventory_count: type.available_inventory_count,
    available_code_count: type.available_code_count,
    redeemed_count: type.redeemed_count,
    field_schema: (type.field_schema || []).map((field) => ({
      key: field.key,
      label: field.label,
      required: field.required,
      sensitive: field.sensitive,
      placeholder: field.placeholder || ""
    }))
  };
}

function createPublicRedeemRecordType(record) {
  return {
    id: record.type_id,
    slug: record.type_slug,
    name: record.type_name,
    description: "",
    field_schema: record.field_schema,
    import_delimiter: record.import_delimiter
  };
}

function formatPublicRedeemRecord(record) {
  return formatRedeemedInventory(createPublicRedeemRecordType(record), record.payload);
}

function normalizeRedeemTypePayload(body) {
  try {
    return {
      ok: true,
      data: normalizeRedeemEmailTypeInput(body || {})
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message || "兑换类型配置不合法"
    };
  }
}

function normalizeExpiresAt(value) {
  if (!value) {
    return null;
  }

  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new Error("过期时间格式不正确");
  }

  return date.toISOString();
}

function getRequesterIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  return forwarded || req.socket?.remoteAddress || "";
}

function formatDbErrorMessage(error, fallback) {
  const message = String(error?.message || fallback || "操作失败");
  if (message.includes("redeem_email_types.slug")) {
    return "类型标识已存在，请更换后重试";
  }
  if (message.includes("redeem_codes.code") || message.includes("redeem_codes.normalized_code")) {
    return "兑换码生成冲突，请重试";
  }
  return message || fallback || "操作失败";
}

function normalizeIdList(values) {
  return [
    ...new Set(
      (values || [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0)
    )
  ];
}

function hasBodyValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function parseOptionalBoundedInt(value, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!hasBodyValue(value)) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return null;
  }

  return parsed;
}

function sanitizeExportCell(value) {
  return String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\t/g, " ")
    .trim();
}

async function persistRefreshedAccountToken(email, account, newRefreshToken) {
  if (
    !newRefreshToken ||
    newRefreshToken === account.refresh_token ||
    account.source !== "redeem_inventory"
  ) {
    return false;
  }

  const nextPayload = { ...(account.payload || {}) };
  if (nextPayload.raw_line) {
    nextPayload.raw_line = [
      email,
      account.password || "",
      account.client_id || CLIENT_ID,
      newRefreshToken
    ].join("----");
  } else if ("refreshtoken" in nextPayload) {
    nextPayload.refreshtoken = newRefreshToken;
  } else {
    nextPayload.refresh_token = newRefreshToken;
  }

  updateRedeemInventoryPayload(account.inventory_id, nextPayload);
  logger.info("account_refresh_token_updated", { email });
  return true;
}

function parseMailFolder(value) {
  const normalized = String(value || "inbox").trim().toLowerCase();
  if (!normalized || normalized === "inbox") {
    return "inbox";
  }
  if (normalized === "spam" || normalized === "junk") {
    return "spam";
  }

  throw new Error("folder 仅支持 inbox 或 spam");
}

function normalizeTempMailboxPayload(payload = {}) {
  const email = normalizeEmail(payload.email);
  const refreshToken = String(payload.refresh_token || "").trim();

  if (!email || !refreshToken) {
    throw new Error("邮箱和 Refresh Token 为必填项");
  }

  return {
    email,
    password: String(payload.password || ""),
    client_id: String(payload.client_id || CLIENT_ID),
    refresh_token: refreshToken
  };
}

function serializeMailListResult(result) {
  return {
    email: result.email,
    folder: result.folder,
    total: result.total,
    page: result.page,
    page_size: result.page_size,
    items: result.items
  };
}

function serializeMailDetailResult(result) {
  return {
    email: result.email,
    folder: result.folder,
    item: result.item
  };
}

async function fetchStoredAccountMessages(email, top, folder = "inbox") {
  const account = getMailboxAccountFromInventory(email);
  if (!account) {
    throw new Error(`邮箱 ${email} 未在配置中找到`);
  }

  const result = await getMessagesWithContent({ email, ...account }, top, folder);
  await persistRefreshedAccountToken(email, account, result.refreshToken);
  return result;
}

async function fetchStoredAccountMessagesPaged(email, options = {}) {
  const account = getMailboxAccountFromInventory(email);
  if (!account) {
    throw new Error(`邮箱 ${email} 未在配置中找到`);
  }

  const result = await getMailMessagesPaged({ email, ...account }, options);
  await persistRefreshedAccountToken(email, account, result.refreshToken);
  return result;
}

async function fetchStoredAccountMessageDetail(email, options = {}) {
  const account = getMailboxAccountFromInventory(email);
  if (!account) {
    throw new Error(`邮箱 ${email} 未在配置中找到`);
  }

  const result = await getMailMessageDetail({ email, ...account }, options);
  await persistRefreshedAccountToken(email, account, result.refreshToken);
  return result;
}

app.get("/api/messages", async (req, res) => {
  try {
    const email = normalizeEmail(req.query.email);
    const configuredLimit = parseBoundedInt(
      getSystemConfig().email_limit,
      DEFAULT_EMAIL_LIMIT,
      { min: 1, max: 50 }
    );
    const top = parseBoundedInt(req.query.top, configuredLimit, { min: 1, max: 50 });
    const folder = parseMailFolder(req.query.folder);

    if (!email) {
      res.json(fail("请提供邮箱地址"));
      return;
    }

    const result = await fetchStoredAccountMessages(email, top, folder);
    res.json(ok(result.messages));
  } catch (error) {
    logger.error("api_messages_failed", { error });
    res.json(fail(`获取邮件列表失败: ${error.message}`));
  }
});

app.get("/api/message/:messageId", (_, res) => {
  res.json(fail("请使用 /api/messages 接口获取邮件列表，包含完整内容"));
});

app.post("/api/temp-messages", async (req, res) => {
  try {
    const payload = normalizeTempMailboxPayload(req.body || {});
    const top = parseBoundedInt(req.body?.top, 1, { min: 1, max: 50 });
    const folder = parseMailFolder(req.body?.folder);

    const result = await getMessagesWithContent(
      payload,
      top,
      folder
    );

    res.json(ok(result.messages));
  } catch (error) {
    logger.error("api_temp_messages_failed", { error });
    res.json(fail(`获取邮件失败: ${error.message}`));
  }
});

app.get("/api/mailboxes/messages", async (req, res) => {
  try {
    const email = normalizeEmail(req.query.email);
    const configuredLimit = parseBoundedInt(
      getSystemConfig().email_limit,
      DEFAULT_EMAIL_LIMIT,
      { min: 1, max: 100 }
    );
    const folder = parseMailFolder(req.query.folder);
    const page = parseBoundedInt(req.query.page, 1, { min: 1, max: 100000 });
    const pageSize = parseBoundedInt(req.query.page_size, configuredLimit, {
      min: 1,
      max: 100
    });

    if (!email) {
      res.status(400).json(fail("请提供邮箱地址"));
      return;
    }

    const result = await fetchStoredAccountMessagesPaged(email, {
      folder,
      page,
      pageSize
    });
    res.json(ok(serializeMailListResult(result), `共 ${result.total} 封邮件`));
  } catch (error) {
    logger.error("api_mailboxes_messages_failed", { error });
    res.status(400).json(fail(`获取邮件列表失败: ${error.message}`));
  }
});

app.get("/api/mailboxes/messages/:messageId", async (req, res) => {
  try {
    const email = normalizeEmail(req.query.email);
    const folder = parseMailFolder(req.query.folder);

    if (!email) {
      res.status(400).json(fail("请提供邮箱地址"));
      return;
    }

    const result = await fetchStoredAccountMessageDetail(email, {
      folder,
      messageId: req.params.messageId
    });
    res.json(ok(serializeMailDetailResult(result), "邮件详情获取成功"));
  } catch (error) {
    logger.error("api_mailboxes_message_detail_failed", { error });
    res.status(400).json(fail(`获取邮件详情失败: ${error.message}`));
  }
});

app.post("/api/mailboxes/temp/messages", async (req, res) => {
  try {
    const payload = normalizeTempMailboxPayload(req.body || {});
    const folder = parseMailFolder(req.body?.folder);
    const page = parseBoundedInt(req.body?.page, 1, { min: 1, max: 100000 });
    const pageSize = parseBoundedInt(req.body?.page_size, DEFAULT_EMAIL_LIMIT, {
      min: 1,
      max: 100
    });

    const result = await getMailMessagesPaged(payload, {
      folder,
      page,
      pageSize
    });
    res.json(ok(serializeMailListResult(result), `共 ${result.total} 封邮件`));
  } catch (error) {
    logger.error("api_mailboxes_temp_messages_failed", { error });
    res.status(400).json(fail(`获取邮件列表失败: ${error.message}`));
  }
});

app.post("/api/mailboxes/temp/messages/:messageId", async (req, res) => {
  try {
    const payload = normalizeTempMailboxPayload(req.body || {});
    const folder = parseMailFolder(req.body?.folder);

    const result = await getMailMessageDetail(payload, {
      folder,
      messageId: req.params.messageId
    });
    res.json(ok(serializeMailDetailResult(result), "邮件详情获取成功"));
  } catch (error) {
    logger.error("api_mailboxes_temp_message_detail_failed", { error });
    res.status(400).json(fail(`获取邮件详情失败: ${error.message}`));
  }
});

app.post("/api/admin/verify", (req, res) => {
  const token = String(req.body?.token || "");
  if (verifyAdminToken(token)) {
    res.json(ok(null, "验证成功"));
    return;
  }
  res.json(fail("令牌无效"));
});

app.post("/api/admin/password", requireAdmin, (req, res) => {
  const currentToken = String(req.body?.current_token || "");
  const nextToken = String(req.body?.new_token || "").trim();

  if (currentToken !== getAdminToken()) {
    res.status(400).json(fail("当前管理密码不正确"));
    return;
  }

  if (nextToken.length < 4) {
    res.status(400).json(fail("新密码长度不能少于 4 位"));
    return;
  }

  setSystemConfigValue("admin_token", nextToken);
  res.json(ok({ token: nextToken }, "管理密码修改成功"));
});

app.get("/api/ui/ads", (_, res) => {
  res.json(ok(getAdSlotConfig(), "广告位配置获取成功"));
});

app.get("/api/ui/faq", (_, res) => {
  res.json(ok({ html: getFaqHtml() }, "FAQ 配置获取成功"));
});

app.get("/api/system/config", requireAdmin, (_, res) => {
  res.json(ok(getSystemConfig()));
});

app.post("/api/system/config", requireAdmin, (req, res) => {
  const emailLimit = Number(req.body?.email_limit);
  if (!Number.isInteger(emailLimit) || emailLimit < 1 || emailLimit > 50) {
    res.json(fail("邮件限制必须在1-50之间"));
    return;
  }
  setSystemConfigValue("email_limit", emailLimit);
  res.json(ok(null, `系统配置更新成功，邮件限制设置为 ${emailLimit}`));
});

app.get("/api/system/ads", requireAdmin, (_, res) => {
  res.json(ok(getAdSlotConfig(), "广告位配置获取成功"));
});

app.post("/api/system/ads", requireAdmin, (req, res) => {
  const adSlot = saveAdSlotConfig(req.body || {});
  res.json(ok(adSlot, "广告位配置更新成功"));
});

app.get("/api/system/faq", requireAdmin, (_, res) => {
  res.json(ok({ html: getFaqHtml() }, "FAQ 配置获取成功"));
});

app.post("/api/system/faq", requireAdmin, (req, res) => {
  const html = saveFaqHtml(req.body?.html);
  res.json(ok({ html }, "FAQ 配置更新成功"));
});

app.post("/api/test-email", requireAdmin, async (req, res) => {
  try {
    const payload = req.body || {};
    const email = normalizeEmail(payload.email);
    if (!email) {
      res.json(fail("请提供邮箱地址"));
      return;
    }

    if (payload.refresh_token) {
      const result = await getMessagesWithContent(
        {
          email,
          password: String(payload.password || ""),
          client_id: String(payload.client_id || CLIENT_ID),
          refresh_token: String(payload.refresh_token)
        },
        1
      );
      res.json(ok(result.messages[0] || null, result.messages.length ? "测试成功，获取到最新邮件" : "测试成功，但该邮箱暂无邮件"));
      return;
    }

    const account = getMailboxAccountFromInventory(email);
    if (!account) {
      res.json(fail("邮箱未在配置中找到"));
      return;
    }

    const result = await fetchStoredAccountMessages(email, 1);
    res.json(ok(result.messages[0] || null, result.messages.length ? "测试成功，获取到最新邮件" : "测试成功，但该邮箱暂无邮件"));
  } catch (error) {
    logger.error("api_test_email_failed", { error });
    res.json(fail(`测试失败: ${error.message}`));
  }
});

app.get("/api/redeem/catalog", (_, res) => {
  const types = getRedeemEmailTypes().map(serializeRedeemTypeForPublic);
  res.json(
    ok(
      {
        types
      },
      "兑换类型获取成功"
    )
  );
});

app.post("/api/redeem/access", async (req, res) => {
  const code = String(req.body?.code || "").trim();
  const page = parseBoundedInt(req.body?.page, 1, { min: 1, max: 100000 });
  const pageSize = parseBoundedInt(req.body?.page_size, 10, { min: 1, max: 100 });
  if (!code) {
    res.status(400).json(fail("请输入兑换码"));
    return;
  }

  try {
    const codeInfo = getRedeemCodeByCode(code);
    if (!codeInfo) {
      res.status(404).json(fail("兑换码不存在"));
      return;
    }

    if (codeInfo.derived_status === "disabled") {
      res.status(400).json(fail("兑换码已禁用"));
      return;
    }

    if (codeInfo.derived_status === "expired") {
      res.status(400).json(fail("兑换码已过期"));
      return;
    }

    if (codeInfo.status === "unused") {
      const redeemed = redeemByCode({
        code,
        requester_ip: getRequesterIp(req),
        requester_user_agent: String(req.headers["user-agent"] || "")
      });

      res.json(
        ok(
          {
            source: "newly_redeemed",
            code: redeemed.code.code,
            redeemed_at: redeemed.code.redeemed_at,
            total: redeemed.redeemed_count,
            page,
            page_size: pageSize,
            items: getRedeemRecordsByCodeIdPaged(redeemed.code.id, {
              page,
              page_size: pageSize
            }).items.map((record) =>
              formatPublicRedeemRecord(record)
            )
          },
          "兑换码已兑换并载入邮箱"
        )
      );
      return;
    }

    const records = getRedeemRecordsByCodeIdPaged(codeInfo.id, {
      page,
      page_size: pageSize
    });
    res.json(
      ok(
        {
          source: "existing",
          code: codeInfo.code,
          redeemed_at: codeInfo.redeemed_at,
          total: records.total,
          page: records.page,
          page_size: records.page_size,
          items: records.items.map(formatPublicRedeemRecord)
        },
        "已载入兑换码对应邮箱"
      )
    );
  } catch (error) {
    res.status(400).json(fail(error.message || "兑换码载入失败"));
  }
});

app.post("/api/redeem/query", (req, res) => {
  const code = String(req.body?.code || "").trim();
  if (!code) {
    res.status(400).json(fail("请输入兑换码"));
    return;
  }

  try {
    const codeInfo = getRedeemCodeByCode(code);
    if (!codeInfo) {
      res.status(404).json(fail("兑换码不存在"));
      return;
    }

    const records = getRedeemRecordsByCodeId(codeInfo.id);
    if (!records.length) {
      res.status(400).json(fail("该兑换码尚未兑换，暂无订单可查询"));
      return;
    }

    const firstRecord = records[0];
    res.json(
      ok(
        {
          code: codeInfo.code,
          item_count: records.length,
          redeemed_at: firstRecord.redeemed_at,
          type: {
            id: firstRecord.type_id,
            slug: firstRecord.type_slug,
            name: firstRecord.type_name,
            description: "",
            import_delimiter: firstRecord.import_delimiter
          },
          items: records.map(formatPublicRedeemRecord)
        },
        "订单查询成功"
      )
    );
  } catch (error) {
    res.status(400).json(fail(error.message || "订单查询失败"));
  }
});

app.post("/api/redeem/exchange", (req, res) => {
  const code = String(req.body?.code || "").trim();
  if (!code) {
    res.status(400).json(fail("请输入兑换码"));
    return;
  }

  try {
    const result = redeemByCode({
      code,
      requester_ip: getRequesterIp(req),
      requester_user_agent: String(req.headers["user-agent"] || "")
    });

    res.json(
      ok(
        {
          record_id: result.record_id,
          record_ids: result.record_ids,
          quantity: result.code.quantity,
          redeemed_count: result.redeemed_count,
          redeemed_at: result.code.redeemed_at,
          code: result.code.code,
          items: result.inventories.map((inventory) =>
            formatRedeemedInventory(result.type, inventory.payload)
          ),
          ...(result.inventories[0]
            ? formatRedeemedInventory(result.type, result.inventories[0].payload)
            : {})
        },
        "兑换成功"
      )
    );
  } catch (error) {
    res.status(400).json(fail(error.message || "兑换失败"));
  }
});

app.get("/api/redeem/admin/overview", requireAdmin, (_, res) => {
  res.json(ok(getRedeemAdminOverview(), "兑换系统概览获取成功"));
});

app.get("/api/redeem/admin/types", requireAdmin, (req, res) => {
  const includeInactive = parseBoolean(req.query.include_inactive, false);
  const types = getRedeemEmailTypes({
    include_inactive: includeInactive
  });
  res.json(ok({ items: types }, `共 ${types.length} 个兑换类型`));
});

app.post("/api/redeem/admin/types", requireAdmin, (req, res) => {
  const normalized = normalizeRedeemTypePayload(req.body);
  if (!normalized.ok) {
    res.status(400).json(fail(normalized.error));
    return;
  }

  try {
    const type = createRedeemEmailType(normalized.data);
    res.json(ok(type, "兑换类型创建成功"));
  } catch (error) {
    res.status(400).json(fail(formatDbErrorMessage(error, "兑换类型创建失败")));
  }
});

app.put("/api/redeem/admin/types/:typeId", requireAdmin, (req, res) => {
  const typeId = Number(req.params.typeId);
  if (!Number.isInteger(typeId) || typeId < 1) {
    res.status(400).json(fail("兑换类型不存在"));
    return;
  }

  const currentType = getRedeemEmailTypeById(typeId);
  if (!currentType) {
    res.status(404).json(fail("兑换类型不存在"));
    return;
  }

  const normalized = normalizeRedeemTypePayload(req.body);
  if (!normalized.ok) {
    res.status(400).json(fail(normalized.error));
    return;
  }

  try {
    const type = updateRedeemEmailType(typeId, normalized.data);
    res.json(ok(type || currentType, "兑换类型更新成功"));
  } catch (error) {
    res.status(400).json(fail(formatDbErrorMessage(error, "兑换类型更新失败")));
  }
});

app.get("/api/redeem/admin/inventory", requireAdmin, (req, res) => {
  const result = getRedeemInventoryPaged({
    type_id: req.query.type_id,
    status: String(req.query.status || ""),
    q: String(req.query.q || ""),
    page: parseBoundedInt(req.query.page, 1, { min: 1, max: 100000 }),
    page_size: parseBoundedInt(req.query.page_size, 10, { min: 1, max: 100 })
  });
  res.json(ok(result, `共 ${result.total} 条库存记录`));
});

app.post("/api/redeem/admin/inventory/import", requireAdmin, upload.single("file"), (req, res) => {
  const typeId = Number(req.body?.type_id);
  const uploadedText = req.file?.buffer
    ? req.file.buffer.toString("utf8").replace(/^\uFEFF/, "")
    : "";
  const text = String(req.body?.text || uploadedText || "").trim();
  const mode = String(req.body?.mode || "append");

  if (!Number.isInteger(typeId) || typeId < 1) {
    res.status(400).json(fail("请选择兑换类型"));
    return;
  }

  if (!text) {
    res.status(400).json(fail("请输入要导入的库存文本"));
    return;
  }

  const type = getRedeemEmailTypeById(typeId);
  if (!type) {
    res.status(404).json(fail("兑换类型不存在"));
    return;
  }

  const parsed = parseInventoryImportText({
    text,
    field_schema: type.field_schema,
    import_delimiter: type.import_delimiter
  });

  if (!parsed.items.length) {
    res.status(400).json(
      fail("未解析到可导入的库存数据", {
        parse: parsed
      })
    );
    return;
  }

  try {
    const imported = importRedeemInventory({
      type_id: typeId,
      items: parsed.items,
      mode
    });

    const message = parsed.error_count
      ? `库存导入完成，新增 ${imported.added_count} 条，跳过 ${imported.skipped_count} 条，解析错误 ${parsed.error_count} 条`
      : `库存导入完成，新增 ${imported.added_count} 条，跳过 ${imported.skipped_count} 条`;

    res.json(
      ok(
        {
          type,
          parse: parsed,
          import: imported
        },
        message
      )
    );
  } catch (error) {
    res.status(400).json(fail(formatDbErrorMessage(error, "库存导入失败")));
  }
});

app.delete("/api/redeem/admin/inventory/:inventoryId", requireAdmin, (req, res) => {
  const inventoryId = Number(req.params.inventoryId);
  if (!Number.isInteger(inventoryId) || inventoryId < 1) {
    res.status(400).json(fail("库存记录不存在"));
    return;
  }

  if (!deleteRedeemInventory(inventoryId)) {
    res.status(404).json(fail("库存记录不存在"));
    return;
  }

  res.json(ok({ inventory_id: inventoryId }, "库存记录删除成功"));
});

app.post("/api/redeem/admin/inventory/:inventoryId/status", requireAdmin, (req, res) => {
  const inventoryId = Number(req.params.inventoryId);
  if (!Number.isInteger(inventoryId) || inventoryId < 1) {
    res.status(400).json(fail("库存记录不存在"));
    return;
  }

  try {
    const inventory = updateRedeemInventoryStatus(inventoryId, req.body?.status);
    if (!inventory) {
      res.status(404).json(fail("库存记录不存在"));
      return;
    }

    res.json(ok(inventory, "库存状态更新成功"));
  } catch (error) {
    res.status(400).json(fail(error.message || "库存状态更新失败"));
  }
});

app.post("/api/redeem/admin/inventory/batch-delete", requireAdmin, (req, res) => {
  const inventoryIds = normalizeIdList(req.body?.inventory_ids || []);

  if (!inventoryIds.length) {
    res.status(400).json(fail("请至少选择一条库存记录"));
    return;
  }

  const deletedCount = deleteRedeemInventoryBatch(inventoryIds);
  res.json(
    ok({ deleted_count: deletedCount }, `已删除 ${deletedCount} 条库存记录`)
  );
});

app.post("/api/redeem/admin/inventory/batch-update", requireAdmin, (req, res) => {
  const inventoryIds = normalizeIdList(req.body?.inventory_ids || []);
  if (!inventoryIds.length) {
    res.status(400).json(fail("请至少选择一条库存记录"));
    return;
  }

  const typeId = parseOptionalBoundedInt(req.body?.type_id, { min: 1, max: 1000000000 });
  if (hasBodyValue(req.body?.type_id) && !typeId) {
    res.status(400).json(fail("请选择有效的兑换类型"));
    return;
  }

  const nextStatus = hasBodyValue(req.body?.status) ? String(req.body?.status).trim() : null;
  if (nextStatus && nextStatus !== "available" && nextStatus !== "unavailable") {
    res.status(400).json(fail("库存状态仅支持可用或不可用"));
    return;
  }

  if (!typeId && !nextStatus) {
    res.status(400).json(fail("请至少指定一个库存修改项"));
    return;
  }

  try {
    const updated = updateRedeemInventoryBatch(inventoryIds, {
      type_id: typeId,
      status: nextStatus
    });
    const message = updated.skipped_count
      ? `已批量更新 ${updated.updated_count} 条库存记录，跳过 ${updated.skipped_count} 条`
      : `已批量更新 ${updated.updated_count} 条库存记录`;
    res.json(ok(updated, message));
  } catch (error) {
    res.status(400).json(fail(error.message || "库存批量更新失败"));
  }
});

app.post("/api/redeem/admin/inventory/export", requireAdmin, (req, res) => {
  const inventoryIds = normalizeIdList(req.body?.inventory_ids || []);

  if (!inventoryIds.length) {
    res.status(400).json(fail("请至少选择一条库存记录"));
    return;
  }

  const items = getRedeemInventoryByIds(inventoryIds);
  if (!items.length) {
    res.status(404).json(fail("未找到可导出的库存记录"));
    return;
  }

  const lines = [
    "# Redeem inventory export",
    `# 导出时间: ${formatDateTime()}`,
    ""
  ];

  for (const item of items) {
    lines.push(item.serialized_value);
  }

  const filename = `redeem_inventory_${formatDateTime().replace(/[-: ]/g, "").slice(0, 15)}.txt`;
  res.setHeader("Content-Disposition", `attachment; filename=${filename}`);
  res.type("text/plain; charset=utf-8").send(lines.join("\n"));
});

app.get("/api/redeem/admin/codes", requireAdmin, (req, res) => {
  const result = getRedeemCodesPaged({
    type_id: req.query.type_id,
    status: String(req.query.status || ""),
    q: String(req.query.q || ""),
    min_quantity: req.query.min_quantity,
    max_quantity: req.query.max_quantity,
    page: parseBoundedInt(req.query.page, 1, { min: 1, max: 100000 }),
    page_size: parseBoundedInt(req.query.page_size, 10, { min: 1, max: 100 })
  });
  res.json(ok(result, `共 ${result.total} 个兑换码`));
});

app.post("/api/redeem/admin/codes/generate", requireAdmin, (req, res) => {
  const typeId = Number(req.body?.type_id);
  if (!Number.isInteger(typeId) || typeId < 1) {
    res.status(400).json(fail("请选择兑换类型"));
    return;
  }

  try {
    const codes = createRedeemCodes({
      type_id: typeId,
      count: parseBoundedInt(req.body?.count, 1, { min: 1 }),
      quantity: parseBoundedInt(req.body?.quantity, 1, { min: 1 }),
      note: String(req.body?.note || ""),
      expires_at: normalizeExpiresAt(req.body?.expires_at)
    });
    res.json(ok({ items: codes }, `已生成 ${codes.length} 个兑换码`));
  } catch (error) {
    res.status(400).json(fail(formatDbErrorMessage(error, "兑换码生成失败")));
  }
});

app.post("/api/redeem/admin/codes/:codeId/status", requireAdmin, (req, res) => {
  const codeId = Number(req.params.codeId);
  if (!Number.isInteger(codeId) || codeId < 1) {
    res.status(400).json(fail("兑换码不存在"));
    return;
  }

  try {
    const code = updateRedeemCodeStatus(codeId, req.body?.status);
    if (!code) {
      res.status(404).json(fail("兑换码不存在"));
      return;
    }
    res.json(ok(code, "兑换码状态更新成功"));
  } catch (error) {
    res.status(400).json(fail(error.message || "兑换码状态更新失败"));
  }
});

app.delete("/api/redeem/admin/codes/:codeId", requireAdmin, (req, res) => {
  const codeId = Number(req.params.codeId);
  if (!Number.isInteger(codeId) || codeId < 1) {
    res.status(400).json(fail("兑换码不存在"));
    return;
  }

  try {
    const deleted = deleteRedeemCode(codeId);
    if (!deleted) {
      res.status(404).json(fail("兑换码不存在"));
      return;
    }

    res.json(ok({ code_id: codeId }, "兑换码删除成功"));
  } catch (error) {
    res.status(400).json(fail(error.message || "兑换码删除失败"));
  }
});

app.post("/api/redeem/admin/codes/batch-status", requireAdmin, (req, res) => {
  const codeIds = normalizeIdList(req.body?.code_ids || []);
  if (!codeIds.length) {
    res.status(400).json(fail("请至少选择一个兑换码"));
    return;
  }

  try {
    const updated = updateRedeemCodeStatusBatch(codeIds, req.body?.status);
    const actionText = updated.status === "disabled" ? "禁用" : "恢复";
    const message = updated.skipped_count
      ? `已${actionText} ${updated.updated_count} 个兑换码，跳过 ${updated.skipped_count} 个`
      : `已${actionText} ${updated.updated_count} 个兑换码`;
    res.json(ok(updated, message));
  } catch (error) {
    res.status(400).json(fail(error.message || "兑换码批量状态更新失败"));
  }
});

app.post("/api/redeem/admin/codes/batch-delete", requireAdmin, (req, res) => {
  const codeIds = normalizeIdList(req.body?.code_ids || []);
  if (!codeIds.length) {
    res.status(400).json(fail("请至少选择一个兑换码"));
    return;
  }

  try {
    const deleted = deleteRedeemCodeBatch(codeIds);
    const message = deleted.skipped_count
      ? `已删除 ${deleted.deleted_count} 个兑换码，跳过 ${deleted.skipped_count} 个`
      : `已删除 ${deleted.deleted_count} 个兑换码`;
    res.json(ok(deleted, message));
  } catch (error) {
    res.status(400).json(fail(error.message || "兑换码批量删除失败"));
  }
});

app.post("/api/redeem/admin/codes/batch-update", requireAdmin, (req, res) => {
  const codeIds = normalizeIdList(req.body?.code_ids || []);
  if (!codeIds.length) {
    res.status(400).json(fail("请至少选择一个兑换码"));
    return;
  }

  const typeId = parseOptionalBoundedInt(req.body?.type_id, { min: 1, max: 1000000000 });
  if (hasBodyValue(req.body?.type_id) && !typeId) {
    res.status(400).json(fail("请选择有效的兑换类型"));
    return;
  }

  const quantity = parseOptionalBoundedInt(req.body?.quantity, { min: 1 });
  if (hasBodyValue(req.body?.quantity) && !quantity) {
    res.status(400).json(fail("卡密可兑数量需为大于 0 的整数"));
    return;
  }

  if (!typeId && !quantity) {
    res.status(400).json(fail("请至少指定一个卡密修改项"));
    return;
  }

  try {
    const updated = updateRedeemCodeBatch(codeIds, {
      type_id: typeId,
      quantity
    });
    const message = updated.skipped_count
      ? `已批量更新 ${updated.updated_count} 个兑换码，跳过 ${updated.skipped_count} 个`
      : `已批量更新 ${updated.updated_count} 个兑换码`;
    res.json(ok(updated, message));
  } catch (error) {
    res.status(400).json(fail(error.message || "卡密批量更新失败"));
  }
});

app.post("/api/redeem/admin/codes/export", requireAdmin, (req, res) => {
  const codeIds = normalizeIdList(req.body?.code_ids || []);
  const filters = {
    type_id: req.body?.type_id,
    status: String(req.body?.status || ""),
    q: String(req.body?.q || ""),
    min_quantity: req.body?.min_quantity,
    max_quantity: req.body?.max_quantity
  };
  const items = codeIds.length
    ? getRedeemCodesByIds(codeIds)
    : getRedeemCodesForExport(filters);

  if (!items.length) {
    res.status(404).json(fail("未找到可导出的兑换码"));
    return;
  }

  const lines = items.map((item) => item.code);

  const filenameTag = codeIds.length
    ? "selected"
    : sanitizeExportCell(filters.status || "filtered").toLowerCase() || "filtered";
  const filename = `redeem_codes_${filenameTag}_${formatDateTime().replace(/[-: ]/g, "").slice(0, 15)}.txt`;
  res.setHeader("Content-Disposition", `attachment; filename=${filename}`);
  res.type("text/plain; charset=utf-8").send(lines.join("\n"));
});

app.get("/api/redeem/admin/records", requireAdmin, (req, res) => {
  const result = getRedeemRecordsPaged({
    type_id: req.query.type_id,
    q: String(req.query.q || ""),
    page: parseBoundedInt(req.query.page, 1, { min: 1, max: 100000 }),
    page_size: parseBoundedInt(req.query.page_size, 10, { min: 1, max: 100 })
  });
  res.json(ok(result, `共 ${result.total} 条兑换记录`));
});

app.get("/api/redeem/admin/records/:codeId", requireAdmin, (req, res) => {
  const codeId = Number(req.params.codeId);
  if (!Number.isInteger(codeId) || codeId < 1) {
    res.status(400).json(fail("兑换记录不存在"));
    return;
  }

  const items = getRedeemRecordsByCodeId(codeId);
  if (!items.length) {
    res.status(404).json(fail("兑换记录不存在"));
    return;
  }

  res.json(
    ok(
      {
        code_id: codeId,
        code: items[0].code,
        type_id: items[0].type_id,
        type_name: items[0].type_name,
        type_slug: items[0].type_slug,
        redeemed_at: items[0].redeemed_at,
        item_count: items.length,
        items
      },
      "兑换记录详情获取成功"
    )
  );
});

app.use(express.static(FRONTEND_DIST_DIR, { index: false }));

app.get("/", (_, res) => sendFrontendIndex(res));
app.get("/redeem", (_, res) => sendFrontendIndex(res));
app.get("/mail", (_, res) => sendFrontendIndex(res));
app.get(ADMIN_PATH, (_, res) => sendFrontendIndex(res));

app.listen(PORT, HOST, () => {
  logger.info("server_started", { url: `http://${HOST}:${PORT}` });
});

process.on("SIGINT", () => {
  closeDb();
  process.exit(0);
});
