import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  CLIENT_ID,
  GRAPH_API_BASE,
  GRAPH_OAUTH_SCOPE
} from "./config.js";
import { refreshAccessToken } from "./auth.js";
import { createLogger, elapsedMs } from "./logger.js";

const logger = createLogger("graph");
const inFlightFetches = new Map();
const GRAPH_FOLDER_MAP = {
  inbox: "inbox",
  spam: "junkemail"
};
const LIST_SELECT = [
  "id",
  "subject",
  "sender",
  "from",
  "toRecipients",
  "receivedDateTime",
  "bodyPreview"
].join(",");
const BODY_SELECT = `${LIST_SELECT},body`;
const GRAPH_MAIL_READ_SCOPE = "https://graph.microsoft.com/Mail.Read";

function normalizePage(value) {
  return Math.max(1, Number(value) || 1);
}

function normalizePageSize(value) {
  return Math.max(1, Math.min(100, Number(value) || 10));
}

function normalizeTop(top) {
  return Math.max(1, Math.min(50, Number(top) || 1));
}

function normalizeFolderKey(folder) {
  const normalized = String(folder || "inbox").trim().toLowerCase();
  if (normalized === "junk") {
    return "spam";
  }

  return normalized === "spam" ? "spam" : "inbox";
}

function resolveGraphFolderId(folder) {
  return GRAPH_FOLDER_MAP[normalizeFolderKey(folder)] || GRAPH_FOLDER_MAP.inbox;
}

function createRequestKey(account, descriptor) {
  return [
    account.email || "",
    account.client_id || CLIENT_ID,
    account.refresh_token || "",
    JSON.stringify(descriptor)
  ].join("::");
}

function createGraphUrl(pathname, params = {}) {
  const url = new URL(`${GRAPH_API_BASE}${pathname}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url;
}

function normalizeContentType(value) {
  const contentType = String(value || "text").trim().toLowerCase();
  return contentType === "html" ? "html" : "text";
}

function decodeJwtPayload(token) {
  const [, encodedPayload] = String(token || "").split(".");
  if (!encodedPayload) {
    return null;
  }

  try {
    const normalized = encodedPayload
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(encodedPayload.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(normalized, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function hasMailReadClaim(value) {
  return String(value || "")
    .split(/\s+/)
    .some((scope) => scope === GRAPH_MAIL_READ_SCOPE || scope === "Mail.Read");
}

function tokenHasGraphMailRead(tokenData) {
  if (hasMailReadClaim(tokenData?.scope)) {
    return true;
  }

  const payload = decodeJwtPayload(tokenData?.access_token);
  if (hasMailReadClaim(payload?.scp)) {
    return true;
  }

  return Array.isArray(payload?.roles) && payload.roles.includes("Mail.Read");
}

function tokenPermissionLooksMissing(tokenData) {
  const payload = decodeJwtPayload(tokenData?.access_token);
  const scopeText = String(tokenData?.scope || "").trim();
  const tokenScopeText = String(payload?.scp || "").trim();
  const tokenRoles = Array.isArray(payload?.roles) ? payload.roles : [];

  if (tokenHasGraphMailRead(tokenData)) {
    return false;
  }

  return Boolean(scopeText || tokenScopeText || tokenRoles.length);
}

async function refreshGraphAccessToken(account) {
  return refreshAccessToken(
    account.refresh_token,
    account.client_id || CLIENT_ID,
    { scope: GRAPH_OAUTH_SCOPE }
  );
}

function mapAddress(address) {
  const emailAddress = address?.emailAddress || {};
  return {
    emailAddress: {
      name: emailAddress.name || emailAddress.address || "",
      address: emailAddress.address || ""
    }
  };
}

function mapRecipients(recipients) {
  return (Array.isArray(recipients) ? recipients : []).map(mapAddress);
}

function mapGraphMessage(message, folder) {
  const body = message?.body
    ? {
        contentType: normalizeContentType(message.body.contentType),
        content: String(message.body.content || "")
      }
    : undefined;

  return {
    id: String(message?.id || ""),
    folder: normalizeFolderKey(folder),
    subject: message?.subject || "(无主题)",
    sender: mapAddress(message?.sender || message?.from),
    from: mapAddress(message?.from || message?.sender),
    toRecipients: mapRecipients(message?.toRecipients),
    receivedDateTime: message?.receivedDateTime || new Date().toISOString(),
    bodyPreview: String(message?.bodyPreview || "").trim(),
    ...(body ? { body } : { contentType: "text" })
  };
}

function formatMessageSummary(message) {
  return {
    id: message.id,
    folder: normalizeFolderKey(message.folder),
    subject: message.subject,
    sender: message.sender,
    from: message.from,
    toRecipients: message.toRecipients,
    receivedDateTime: message.receivedDateTime,
    bodyPreview: message.bodyPreview,
    contentType: message.body?.contentType || message.contentType || "text"
  };
}

async function graphRequest(pathname, token, params = {}) {
  const response = await fetch(createGraphUrl(pathname, params), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      Prefer: 'outlook.body-content-type="html"'
    }
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const error = new Error(text || `Graph request failed (${response.status})`);
    error.status = response.status;
    error.responseText = text;
    throw error;
  }

  return await response.json();
}

async function getFolderTotal(folderId, accessToken) {
  const folder = await graphRequest(
    `/me/mailFolders/${encodeURIComponent(folderId)}`,
    accessToken,
    {
      $select: "totalItemCount"
    }
  );
  return Math.max(0, Number(folder?.totalItemCount || 0));
}

async function listMessagesInternal(
  account,
  { folder = "inbox", page = 1, pageSize = 10, includeBodies = false } = {}
) {
  const folderKey = normalizeFolderKey(folder);
  const folderId = resolveGraphFolderId(folderKey);
  const safePage = normalizePage(page);
  const safePageSize = normalizePageSize(pageSize);
  const skip = Math.max(0, (safePage - 1) * safePageSize);
  const requestId = randomUUID().slice(0, 8);
  const requestLogger = logger.child({
    requestId,
    email: account.email,
    action: "list",
    folder: folderKey,
    page: safePage,
    pageSize: safePageSize
  });
  const startedAt = performance.now();

  try {
    const tokenStartedAt = performance.now();
    const tokenData = await refreshGraphAccessToken(account);
    const tokenDurationMs = elapsedMs(tokenStartedAt);

    if (tokenPermissionLooksMissing(tokenData)) {
      requestLogger.warn("graph_token_mail_read_not_confirmed", {
        reason: "Mail.Read not found in token scope claims; trying Graph API"
      });
    }

    requestLogger.info("graph_fetch_started", {
      folder: folderId,
      tokenCached: Boolean(tokenData.cached),
      includeBodies
    });

    const fetchStartedAt = performance.now();
    const [total, payload] = await Promise.all([
      getFolderTotal(folderId, tokenData.access_token),
      graphRequest(
        `/me/mailFolders/${encodeURIComponent(folderId)}/messages`,
        tokenData.access_token,
        {
          $top: safePageSize,
          $skip: skip,
          $orderby: "receivedDateTime desc",
          $select: includeBodies ? BODY_SELECT : LIST_SELECT
        }
      )
    ]);
    const items = (payload?.value || []).map((message) =>
      mapGraphMessage(message, folderKey)
    );
    const fetchDurationMs = elapsedMs(fetchStartedAt);

    requestLogger.info("graph_fetch_completed", {
      folder: folderId,
      fetchedCount: items.length,
      total,
      tokenDurationMs,
      fetchDurationMs,
      totalDurationMs: elapsedMs(startedAt),
      tokenCached: Boolean(tokenData.cached),
      rotatedRefreshToken: tokenData.refresh_token !== account.refresh_token
    });

    return {
      email: account.email,
      folder: folderKey,
      total,
      page: safePage,
      page_size: safePageSize,
      items: includeBodies ? items : items.map(formatMessageSummary),
      refreshToken: tokenData.refresh_token || account.refresh_token,
      metrics: {
        mailboxExists: total,
        fetchedCount: items.length,
        tokenDurationMs,
        fetchPipelineDurationMs: fetchDurationMs,
        totalDurationMs: elapsedMs(startedAt),
        tokenCached: Boolean(tokenData.cached)
      }
    };
  } catch (error) {
    requestLogger.error("graph_fetch_failed", {
      folder: folderId,
      durationMs: elapsedMs(startedAt),
      error
    });
    throw new Error(error?.responseText || error?.message || "Graph request failed");
  }
}

async function getMessageDetailInternal(account, { folder = "inbox", messageId }) {
  const folderKey = normalizeFolderKey(folder);
  const folderId = resolveGraphFolderId(folderKey);
  const targetMessageId = String(messageId || "").trim();

  if (!targetMessageId) {
    throw new Error("邮件 ID 不能为空");
  }

  const requestId = randomUUID().slice(0, 8);
  const requestLogger = logger.child({
    requestId,
    email: account.email,
    action: "detail",
    folder: folderKey,
    messageId: targetMessageId
  });
  const startedAt = performance.now();

  try {
    const tokenStartedAt = performance.now();
    const tokenData = await refreshGraphAccessToken(account);
    const tokenDurationMs = elapsedMs(tokenStartedAt);

    if (tokenPermissionLooksMissing(tokenData)) {
      requestLogger.warn("graph_detail_token_mail_read_not_confirmed", {
        reason: "Mail.Read not found in token scope claims; trying Graph API"
      });
    }

    requestLogger.info("graph_detail_started", {
      folder: folderId,
      tokenCached: Boolean(tokenData.cached)
    });

    const fetchStartedAt = performance.now();
    const message = await graphRequest(
      `/me/mailFolders/${encodeURIComponent(folderId)}/messages/${encodeURIComponent(targetMessageId)}`,
      tokenData.access_token,
      {
        $select: BODY_SELECT
      }
    );
    const item = mapGraphMessage(message, folderKey);
    const fetchDurationMs = elapsedMs(fetchStartedAt);

    requestLogger.info("graph_detail_completed", {
      folder: folderId,
      tokenDurationMs,
      fetchDurationMs,
      totalDurationMs: elapsedMs(startedAt),
      tokenCached: Boolean(tokenData.cached),
      rotatedRefreshToken: tokenData.refresh_token !== account.refresh_token
    });

    return {
      email: account.email,
      folder: folderKey,
      item,
      refreshToken: tokenData.refresh_token || account.refresh_token,
      metrics: {
        tokenDurationMs,
        fetchDurationMs,
        totalDurationMs: elapsedMs(startedAt),
        tokenCached: Boolean(tokenData.cached)
      }
    };
  } catch (error) {
    requestLogger.error("graph_detail_failed", {
      folder: folderId,
      durationMs: elapsedMs(startedAt),
      error
    });
    throw new Error(error?.responseText || error?.message || "Graph request failed");
  }
}

export async function getGraphMailMessagesPaged(account, options = {}) {
  const descriptor = {
    protocol: "graph",
    action: "list",
    folder: normalizeFolderKey(options.folder),
    page: normalizePage(options.page),
    pageSize: normalizePageSize(options.pageSize),
    includeBodies: Boolean(options.includeBodies)
  };
  const key = createRequestKey(account, descriptor);
  const inFlight = inFlightFetches.get(key);

  if (inFlight) {
    logger.debug("graph_fetch_join_inflight", {
      email: account.email,
      ...descriptor
    });
    return inFlight;
  }

  const requestPromise = listMessagesInternal(account, options).finally(() => {
    if (inFlightFetches.get(key) === requestPromise) {
      inFlightFetches.delete(key);
    }
  });

  inFlightFetches.set(key, requestPromise);
  return requestPromise;
}

export async function getGraphMailMessageDetail(account, options = {}) {
  const descriptor = {
    protocol: "graph",
    action: "detail",
    folder: normalizeFolderKey(options.folder),
    messageId: String(options.messageId || "").trim()
  };
  const key = createRequestKey(account, descriptor);
  const inFlight = inFlightFetches.get(key);

  if (inFlight) {
    logger.debug("graph_detail_join_inflight", {
      email: account.email,
      ...descriptor
    });
    return inFlight;
  }

  const requestPromise = getMessageDetailInternal(account, options).finally(() => {
    if (inFlightFetches.get(key) === requestPromise) {
      inFlightFetches.delete(key);
    }
  });

  inFlightFetches.set(key, requestPromise);
  return requestPromise;
}

export async function getGraphMessagesWithContent(account, top = 1, folder = "inbox") {
  const result = await getGraphMailMessagesPaged(account, {
    folder,
    page: 1,
    pageSize: normalizeTop(top),
    includeBodies: true
  });

  return {
    messages: result.items,
    refreshToken: result.refreshToken,
    metrics: result.metrics
  };
}
