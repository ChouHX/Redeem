import { performance } from "node:perf_hooks";
import {
  ACCESS_TOKEN_CACHE_SKEW_MS,
  ADMIN_TOKEN,
  CLIENT_ID,
  TOKEN_URL
} from "./config.js";
import { getSystemConfigValue } from "./db.js";
import { elapsedMs, createLogger } from "./logger.js";

const logger = createLogger("auth");
const accessTokenCache = new Map();

function getTokenCacheKey(refreshToken, clientId) {
  return `${clientId || CLIENT_ID}::${refreshToken || ""}`;
}

function toExpiryTimestamp(expiresInSeconds) {
  const expiresInMs = Math.max(60, Number(expiresInSeconds) || 3600) * 1000;
  return Date.now() + expiresInMs;
}

function createCachedResponse(entry) {
  return {
    access_token: entry.accessToken,
    refresh_token: entry.refreshToken,
    expires_in: Math.max(0, Math.floor((entry.expiresAt - Date.now()) / 1000)),
    expires_at: entry.expiresAt,
    cached: true
  };
}

function setAccessTokenCache(refreshToken, clientId, payload) {
  const cacheEntry = {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || refreshToken,
    expiresAt: payload.expires_at || toExpiryTimestamp(payload.expires_in)
  };

  const primaryKey = getTokenCacheKey(refreshToken, clientId);
  accessTokenCache.set(primaryKey, cacheEntry);

  const rotatedKey = getTokenCacheKey(cacheEntry.refreshToken, clientId);
  accessTokenCache.set(rotatedKey, cacheEntry);

  return cacheEntry;
}

export function clearAccessTokenCache(refreshToken, clientId = CLIENT_ID) {
  accessTokenCache.delete(getTokenCacheKey(refreshToken, clientId));
}

export function getAdminToken() {
  return getSystemConfigValue("admin_token") || ADMIN_TOKEN;
}

export function verifyAdminToken(token) {
  return token === getAdminToken();
}

export function getRequestAdminToken(req) {
  const auth = String(req.headers.authorization || "");
  if (!auth.startsWith("Bearer ")) {
    return "";
  }

  return auth.slice(7).trim();
}

export function requireAdmin(req, res, next) {
  const token = getRequestAdminToken(req);
  if (!token) {
    res.status(401).json({ success: false, message: "未提供认证令牌" });
    return;
  }

  if (!verifyAdminToken(token)) {
    res.status(401).json({ success: false, message: "无效的管理令牌" });
    return;
  }

  next();
}

export async function refreshAccessToken(
  refreshToken,
  clientId = CLIENT_ID,
  options = {}
) {
  const normalizedClientId = clientId || CLIENT_ID;
  const cacheKey = getTokenCacheKey(refreshToken, normalizedClientId);
  const forceRefresh = Boolean(options.force);
  const cachedEntry = accessTokenCache.get(cacheKey);

  if (
    !forceRefresh &&
    cachedEntry?.accessToken &&
    cachedEntry.expiresAt > Date.now() + ACCESS_TOKEN_CACHE_SKEW_MS
  ) {
    logger.debug("oauth_refresh_cache_hit", {
      clientId: normalizedClientId,
      expiresInSec: Math.floor((cachedEntry.expiresAt - Date.now()) / 1000)
    });
    return createCachedResponse(cachedEntry);
  }

  if (!forceRefresh && cachedEntry?.promise) {
    logger.debug("oauth_refresh_join_inflight", {
      clientId: normalizedClientId
    });
    return cachedEntry.promise;
  }

  const startedAt = performance.now();
  const body = new URLSearchParams({
    client_id: normalizedClientId,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: "https://outlook.office.com/IMAP.AccessAsUser.All offline_access"
  });

  const requestPromise = (async () => {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      body
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || "Refresh token已过期或无效");
    }

    const payload = await response.json();
    if (!payload.access_token) {
      throw new Error(payload.error_description || "获取 access_token 失败");
    }

    const normalizedPayload = {
      ...payload,
      refresh_token: payload.refresh_token || refreshToken,
      expires_at: toExpiryTimestamp(payload.expires_in),
      cached: false
    };

    setAccessTokenCache(refreshToken, normalizedClientId, normalizedPayload);

    logger.info("oauth_refresh_succeeded", {
      clientId: normalizedClientId,
      durationMs: elapsedMs(startedAt),
      expiresInSec: Number(payload.expires_in) || 0,
      rotatedRefreshToken:
        normalizedPayload.refresh_token !== refreshToken
    });

    return normalizedPayload;
  })();

  accessTokenCache.set(cacheKey, {
    ...(cachedEntry || {}),
    promise: requestPromise
  });

  try {
    return await requestPromise;
  } catch (error) {
    accessTokenCache.delete(cacheKey);
    logger.warn("oauth_refresh_failed", {
      clientId: normalizedClientId,
      durationMs: elapsedMs(startedAt),
      error
    });
    throw error;
  } finally {
    const currentEntry = accessTokenCache.get(cacheKey);
    if (currentEntry?.promise === requestPromise) {
      if (currentEntry.accessToken) {
        accessTokenCache.set(cacheKey, {
          accessToken: currentEntry.accessToken,
          refreshToken: currentEntry.refreshToken,
          expiresAt: currentEntry.expiresAt
        });
      } else {
        accessTokenCache.delete(cacheKey);
      }
    }
  }
}
