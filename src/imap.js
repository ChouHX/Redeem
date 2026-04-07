import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import {
  CLIENT_ID,
  IMAP_CONNECTION_TIMEOUT,
  IMAP_GREETING_TIMEOUT,
  IMAP_PARSE_CONCURRENCY,
  IMAP_PORT,
  IMAP_RESOLVE_INLINE_IMAGES,
  IMAP_SERVER,
  IMAP_SOCKET_TIMEOUT,
  INBOX_FOLDER_NAME,
  JUNK_FOLDER_NAME,
  MAILPARSER_MAX_HTML_LENGTH
} from "./config.js";
import { refreshAccessToken } from "./auth.js";
import { createLogger, elapsedMs } from "./logger.js";

const logger = createLogger("imap");
const inFlightFetches = new Map();
const parserConcurrency = Math.max(1, Number(IMAP_PARSE_CONCURRENCY) || 1);
const fetchQuery = {
  uid: true,
  envelope: true,
  source: true,
  internalDate: true,
  size: true
};
const mailParserOptions = {
  skipHtmlToText: true,
  skipTextToHtml: true,
  skipTextLinks: true,
  skipImageLinks: !IMAP_RESOLVE_INLINE_IMAGES,
  maxHtmlLengthToParse: MAILPARSER_MAX_HTML_LENGTH
};
const MAIL_FOLDER_MAP = {
  inbox: INBOX_FOLDER_NAME,
  spam: JUNK_FOLDER_NAME
};

function mapAddressObject(address) {
  return {
    emailAddress: {
      name: address?.name || address?.address || "",
      address: address?.address || ""
    }
  };
}

function mapAddressList(addresses) {
  return (addresses || []).map(mapAddressObject);
}

function stripHtmlTags(html) {
  return String(html || "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function extractBody(parsed) {
  if (parsed.html) {
    return { contentType: "html", content: String(parsed.html) };
  }

  return { contentType: "text", content: String(parsed.text || "") };
}

function bodyPreviewFromText(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 160);
}

function buildBodyPreview(parsed) {
  return bodyPreviewFromText(parsed.text || stripHtmlTags(parsed.html || ""));
}

function toIsoString(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString();
  }

  return date.toISOString();
}

function normalizeTop(top) {
  return Math.max(1, Math.min(50, Number(top) || 1));
}

function normalizePage(value) {
  return Math.max(1, Number(value) || 1);
}

function normalizePageSize(value) {
  return Math.max(1, Math.min(100, Number(value) || 10));
}

function normalizeFolderKey(folder) {
  const normalized = String(folder || "inbox").trim().toLowerCase();
  if (normalized === "junk") {
    return "spam";
  }

  return normalized === "spam" ? "spam" : "inbox";
}

function resolveFolderName(folder) {
  return MAIL_FOLDER_MAP[normalizeFolderKey(folder)] || INBOX_FOLDER_NAME;
}

function createRequestKey(account, descriptor) {
  return [
    account.email || "",
    account.client_id || CLIENT_ID,
    account.refresh_token || "",
    JSON.stringify(descriptor)
  ].join("::");
}

function getClientStats(client) {
  try {
    return client.stats();
  } catch {
    return { sent: 0, received: 0 };
  }
}

function createImapClient(account, requestId, requestLogger) {
  const client = new ImapFlow({
    id: `imap-${requestId}`,
    host: IMAP_SERVER,
    port: IMAP_PORT,
    secure: true,
    connectionTimeout: IMAP_CONNECTION_TIMEOUT,
    greetingTimeout: IMAP_GREETING_TIMEOUT,
    socketTimeout: IMAP_SOCKET_TIMEOUT,
    auth: {
      user: account.email,
      accessToken: account.access_token,
      method: "XOAUTH2"
    },
    logger: false
  });

  client.on("error", (error) => {
    requestLogger.warn("imap_client_error", { error });
  });

  return client;
}

function getSequenceRange(exists, page, pageSize) {
  const safeExists = Math.max(0, Number(exists) || 0);
  const safePage = normalizePage(page);
  const safePageSize = normalizePageSize(pageSize);
  const endSeq = safeExists - (safePage - 1) * safePageSize;

  if (endSeq < 1) {
    return null;
  }

  const startSeq = Math.max(1, endSeq - safePageSize + 1);
  return {
    startSeq,
    endSeq,
    range: startSeq === endSeq ? String(endSeq) : `${startSeq}:${endSeq}`
  };
}

async function parseFetchedMessage(fetched, folder) {
  if (!fetched?.source) {
    return null;
  }

  const parsed = await simpleParser(fetched.source, mailParserOptions);
  const body = extractBody(parsed);
  const envelope = fetched.envelope || {};
  const parsedTo = parsed.to?.value || [];
  const parsedFrom = parsed.from?.value || [];
  const fromAddress =
    parsedFrom[0] || envelope.from?.[0] || envelope.sender?.[0] || null;
  const toRecipients = parsedTo.length
    ? parsedTo.map(mapAddressObject)
    : mapAddressList(envelope.to);

  return {
    id: String(fetched.uid || fetched.seq || ""),
    folder: normalizeFolderKey(folder),
    subject: envelope.subject || parsed.subject || "(无主题)",
    sender: mapAddressObject(fromAddress),
    from: mapAddressObject(fromAddress),
    toRecipients,
    receivedDateTime: toIsoString(
      fetched.internalDate || envelope.date || parsed.date
    ),
    bodyPreview: buildBodyPreview(parsed),
    body
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
    contentType: message.body?.contentType || "text"
  };
}

async function fetchAndParseSingleMessage(client, sequenceNumber, folder) {
  const fetched = await client.fetchOne(sequenceNumber, fetchQuery);
  if (!fetched) {
    return {
      message: null,
      parseDurationMs: 0,
      totalMessageBytes: 0
    };
  }

  const parseStartedAt = performance.now();
  const message = await parseFetchedMessage(fetched, folder);
  return {
    message,
    parseDurationMs: elapsedMs(parseStartedAt),
    totalMessageBytes: Number(fetched.size || 0)
  };
}

async function fetchAndParseMessageRange(
  client,
  sequenceRange,
  requestLogger,
  folder
) {
  const messages = [];
  const parseErrors = [];
  let totalMessageBytes = 0;
  let parseDurationMs = 0;
  let batch = [];

  async function flushBatch() {
    if (!batch.length) {
      return;
    }

    const currentBatch = batch;
    batch = [];
    const batchStartedAt = performance.now();
    const settled = await Promise.all(
      currentBatch.map(async (fetched) => {
        totalMessageBytes += Number(fetched?.size || 0);

        try {
          return await parseFetchedMessage(fetched, folder);
        } catch (error) {
          parseErrors.push(error);
          requestLogger.warn("imap_message_parse_failed", {
            uid: fetched?.uid || null,
            seq: fetched?.seq || null,
            size: Number(fetched?.size || 0),
            error
          });
          return null;
        }
      })
    );

    parseDurationMs += elapsedMs(batchStartedAt);

    for (const parsed of settled) {
      if (parsed) {
        messages.push(parsed);
      }
    }
  }

  for await (const fetched of client.fetch(sequenceRange, fetchQuery)) {
    batch.push(fetched);
    if (batch.length >= parserConcurrency) {
      await flushBatch();
    }
  }

  await flushBatch();

  return {
    messages,
    parseErrors,
    parseDurationMs: Number(parseDurationMs.toFixed(1)),
    totalMessageBytes
  };
}

async function listMessagesInternal(
  account,
  { folder = "inbox", page = 1, pageSize = 10, includeBodies = false } = {}
) {
  const folderKey = normalizeFolderKey(folder);
  const folderName = resolveFolderName(folderKey);
  const safePage = normalizePage(page);
  const safePageSize = normalizePageSize(pageSize);
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

  const tokenStartedAt = performance.now();
  const tokenData = await refreshAccessToken(
    account.refresh_token,
    account.client_id || CLIENT_ID
  );
  const tokenDurationMs = elapsedMs(tokenStartedAt);
  const client = createImapClient(
    { ...account, access_token: tokenData.access_token },
    requestId,
    requestLogger
  );

  requestLogger.info("imap_fetch_started", {
    mailbox: folderName,
    parserConcurrency,
    tokenCached: Boolean(tokenData.cached),
    includeBodies
  });

  try {
    const connectStartedAt = performance.now();
    await client.connect();
    const connectDurationMs = elapsedMs(connectStartedAt);

    const openStartedAt = performance.now();
    const mailbox = await client.mailboxOpen(folderName, {
      readOnly: true
    });
    const openDurationMs = elapsedMs(openStartedAt);
    const exists = Number(mailbox?.exists || 0);

    if (!exists) {
      const stats = getClientStats(client);
      requestLogger.info("imap_fetch_completed", {
        mailbox: folderName,
        mailboxExists: exists,
        fetchedCount: 0,
        sequenceRange: null,
        tokenDurationMs,
        connectDurationMs,
        openDurationMs,
        fetchPipelineDurationMs: 0,
        parseDurationMs: 0,
        totalDurationMs: elapsedMs(startedAt),
        sentBytes: stats.sent,
        receivedBytes: stats.received,
        totalMessageBytes: 0,
        rotatedRefreshToken:
          tokenData.refresh_token !== account.refresh_token
      });

      return {
        email: account.email,
        folder: folderKey,
        total: 0,
        page: safePage,
        page_size: safePageSize,
        items: [],
        refreshToken: tokenData.refresh_token || account.refresh_token,
        metrics: {
          mailboxExists: exists,
          fetchedCount: 0,
          tokenDurationMs,
          connectDurationMs,
          openDurationMs,
          fetchPipelineDurationMs: 0,
          parseDurationMs: 0,
          totalDurationMs: elapsedMs(startedAt),
          sentBytes: stats.sent,
          receivedBytes: stats.received,
          totalMessageBytes: 0,
          tokenCached: Boolean(tokenData.cached)
        }
      };
    }

    const range = getSequenceRange(exists, safePage, safePageSize);
    const fetchStartedAt = performance.now();
    let parsedMessages = [];
    let parseDurationMs = 0;
    let totalMessageBytes = 0;
    let parseErrors = [];
    let sequenceRange = null;

    if (range?.range && range.startSeq === range.endSeq) {
      sequenceRange = range.range;
      const singleResult = await fetchAndParseSingleMessage(
        client,
        range.range,
        folderKey
      );
      parsedMessages = singleResult.message ? [singleResult.message] : [];
      parseDurationMs = singleResult.parseDurationMs;
      totalMessageBytes = singleResult.totalMessageBytes;
    } else if (range?.range) {
      sequenceRange = range.range;
      const rangeResult = await fetchAndParseMessageRange(
        client,
        range.range,
        requestLogger,
        folderKey
      );
      parsedMessages = rangeResult.messages;
      parseErrors = rangeResult.parseErrors;
      parseDurationMs = rangeResult.parseDurationMs;
      totalMessageBytes = rangeResult.totalMessageBytes;
    }

    const fetchPipelineDurationMs = elapsedMs(fetchStartedAt);
    const messages = parsedMessages.reverse();
    const stats = getClientStats(client);

    if (!messages.length && parseErrors.length) {
      throw parseErrors[0];
    }

    requestLogger.info("imap_fetch_completed", {
      mailbox: folderName,
      mailboxExists: exists,
      fetchedCount: messages.length,
      sequenceRange,
      tokenDurationMs,
      connectDurationMs,
      openDurationMs,
      fetchPipelineDurationMs,
      parseDurationMs,
      totalDurationMs: elapsedMs(startedAt),
      sentBytes: stats.sent,
      receivedBytes: stats.received,
      totalMessageBytes,
      parseErrorCount: parseErrors.length,
      tokenCached: Boolean(tokenData.cached),
      rotatedRefreshToken: tokenData.refresh_token !== account.refresh_token
    });

    return {
      email: account.email,
      folder: folderKey,
      total: exists,
      page: safePage,
      page_size: safePageSize,
      items: includeBodies ? messages : messages.map(formatMessageSummary),
      refreshToken: tokenData.refresh_token || account.refresh_token,
      metrics: {
        mailboxExists: exists,
        fetchedCount: messages.length,
        sequenceRange,
        tokenDurationMs,
        connectDurationMs,
        openDurationMs,
        fetchPipelineDurationMs,
        parseDurationMs,
        totalDurationMs: elapsedMs(startedAt),
        sentBytes: stats.sent,
        receivedBytes: stats.received,
        totalMessageBytes,
        parseErrorCount: parseErrors.length,
        tokenCached: Boolean(tokenData.cached)
      }
    };
  } catch (error) {
    const stats = getClientStats(client);
    requestLogger.error("imap_fetch_failed", {
      mailbox: folderName,
      durationMs: elapsedMs(startedAt),
      sentBytes: stats.sent,
      receivedBytes: stats.received,
      error
    });
    throw new Error(error?.responseText || error?.message || "IMAP command failed");
  } finally {
    await client.logout().catch(() => {});
  }
}

async function getMessageDetailInternal(
  account,
  { folder = "inbox", messageId }
) {
  const folderKey = normalizeFolderKey(folder);
  const folderName = resolveFolderName(folderKey);
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

  const tokenStartedAt = performance.now();
  const tokenData = await refreshAccessToken(
    account.refresh_token,
    account.client_id || CLIENT_ID
  );
  const tokenDurationMs = elapsedMs(tokenStartedAt);
  const client = createImapClient(
    { ...account, access_token: tokenData.access_token },
    requestId,
    requestLogger
  );

  requestLogger.info("imap_detail_started", {
    mailbox: folderName,
    tokenCached: Boolean(tokenData.cached)
  });

  try {
    const connectStartedAt = performance.now();
    await client.connect();
    const connectDurationMs = elapsedMs(connectStartedAt);

    const openStartedAt = performance.now();
    await client.mailboxOpen(folderName, { readOnly: true });
    const openDurationMs = elapsedMs(openStartedAt);

    const fetchStartedAt = performance.now();
    const fetched = await client.fetchOne(targetMessageId, fetchQuery, {
      uid: true
    });
    const fetchDurationMs = elapsedMs(fetchStartedAt);

    if (!fetched) {
      throw new Error("未找到指定邮件");
    }

    const parseStartedAt = performance.now();
    const item = await parseFetchedMessage(fetched, folderKey);
    const parseDurationMs = elapsedMs(parseStartedAt);
    const stats = getClientStats(client);

    requestLogger.info("imap_detail_completed", {
      mailbox: folderName,
      tokenDurationMs,
      connectDurationMs,
      openDurationMs,
      fetchDurationMs,
      parseDurationMs,
      totalDurationMs: elapsedMs(startedAt),
      sentBytes: stats.sent,
      receivedBytes: stats.received,
      totalMessageBytes: Number(fetched.size || 0),
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
        connectDurationMs,
        openDurationMs,
        fetchDurationMs,
        parseDurationMs,
        totalDurationMs: elapsedMs(startedAt),
        sentBytes: stats.sent,
        receivedBytes: stats.received,
        totalMessageBytes: Number(fetched.size || 0),
        tokenCached: Boolean(tokenData.cached)
      }
    };
  } catch (error) {
    const stats = getClientStats(client);
    requestLogger.error("imap_detail_failed", {
      mailbox: folderName,
      durationMs: elapsedMs(startedAt),
      sentBytes: stats.sent,
      receivedBytes: stats.received,
      error
    });
    throw new Error(error?.responseText || error?.message || "IMAP command failed");
  } finally {
    await client.logout().catch(() => {});
  }
}

export async function getMailMessagesPaged(account, options = {}) {
  const descriptor = {
    action: "list",
    folder: normalizeFolderKey(options.folder),
    page: normalizePage(options.page),
    pageSize: normalizePageSize(options.pageSize),
    includeBodies: Boolean(options.includeBodies)
  };
  const key = createRequestKey(account, descriptor);
  const inFlight = inFlightFetches.get(key);

  if (inFlight) {
    logger.debug("imap_fetch_join_inflight", {
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

export async function getMailMessageDetail(account, options = {}) {
  const descriptor = {
    action: "detail",
    folder: normalizeFolderKey(options.folder),
    messageId: String(options.messageId || "").trim()
  };
  const key = createRequestKey(account, descriptor);
  const inFlight = inFlightFetches.get(key);

  if (inFlight) {
    logger.debug("imap_fetch_join_inflight", {
      email: account.email,
      ...descriptor
    });
    return inFlight;
  }

  const requestPromise = getMessageDetailInternal(account, options).finally(
    () => {
      if (inFlightFetches.get(key) === requestPromise) {
        inFlightFetches.delete(key);
      }
    }
  );

  inFlightFetches.set(key, requestPromise);
  return requestPromise;
}

export async function getMessagesWithContent(
  account,
  top = 1,
  folder = "inbox"
) {
  const result = await getMailMessagesPaged(account, {
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
