import { parentPort, workerData } from "node:worker_threads";
import { classifyOauthFailure } from "./token-check.js";

const candidates = Array.isArray(workerData?.candidates) ? workerData.candidates : [];
const tokenUrl = String(workerData?.token_url || "");
const imapScope = String(workerData?.imap_scope || "");
const graphScope = String(workerData?.graph_scope || "");
const concurrency = Math.max(1, Math.min(16, Number(workerData?.concurrency) || 4));
const timeoutMs = Math.max(1000, Number(workerData?.timeout_ms) || 15000);

async function checkCandidate(candidate) {
  const checkedAt = new Date().toISOString();
  const baseResult = {
    inventory_id: Number(candidate?.inventory_id),
    email: String(candidate?.credentials?.email || ""),
    serialized_value: String(candidate?.serialized_value || ""),
    protocol: String(candidate?.protocol || "imap").toLowerCase() === "graph"
      ? "graph"
      : "imap",
    checked_at: checkedAt
  };
  const credentials = candidate?.credentials;
  if (!credentials?.email || !credentials?.refresh_token) {
    return {
      ...baseResult,
      outcome: "error",
      error_code: "PARSE_ERROR",
      error_message: "库存数据无法解析为邮箱 Refresh Token 凭据"
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = new URLSearchParams({
      client_id: String(credentials.client_id || ""),
      grant_type: "refresh_token",
      refresh_token: String(credentials.refresh_token)
    });
    const scope = baseResult.protocol === "graph" ? graphScope : imapScope;
    if (scope) {
      body.set("scope", scope);
    }

    const response = await fetch(tokenUrl, {
      method: "POST",
      body,
      signal: controller.signal
    });
    const bodyText = await response.text();
    let payload = null;
    try {
      payload = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      payload = null;
    }

    if (!response.ok || !payload?.access_token) {
      return {
        ...baseResult,
        ...classifyOauthFailure(payload, bodyText, response.status)
      };
    }

    return {
      ...baseResult,
      outcome: "live",
      error_code: "",
      error_message: "",
      new_refresh_token:
        payload.refresh_token && payload.refresh_token !== credentials.refresh_token
          ? String(payload.refresh_token)
          : ""
    };
  } catch (error) {
    return {
      ...baseResult,
      outcome: "error",
      error_code: error?.name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR",
      error_message:
        error?.name === "AbortError"
          ? `Token 检测超过 ${timeoutMs}ms`
          : String(error?.message || "Token 检测请求失败")
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

let cursor = 0;

async function runWorker() {
  while (cursor < candidates.length) {
    const index = cursor;
    cursor += 1;
    const result = await checkCandidate(candidates[index]);
    parentPort?.postMessage({ type: "result", result });
  }
}

try {
  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(1, candidates.length)) }, () =>
      runWorker()
    )
  );
  parentPort?.postMessage({ type: "done" });
} catch (error) {
  parentPort?.postMessage({
    type: "fatal",
    message: String(error?.message || "Token 检测线程异常")
  });
}
