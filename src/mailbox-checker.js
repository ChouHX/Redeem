import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { CLIENT_ID } from "./config.js";
import {
  getRedeemInventoryByIds,
  updateRedeemInventoryStatus
} from "./db.js";
import { parseMailboxAccountLine } from "./redeem.js";
import { probeMailboxAvailability } from "./imap.js";
import { createLogger, elapsedMs } from "./logger.js";

const logger = createLogger("mailbox-checker");

const MAX_CONCURRENCY = 8;
const DEFAULT_CONCURRENCY = 4;
const TASK_RETENTION_MS = 30 * 60 * 1000;
const MAX_TASKS_KEPT = 30;

const tasks = new Map();

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
    client_id:
      String(payload.oauth2id || payload.client_id || CLIENT_ID).trim() ||
      CLIENT_ID,
    refresh_token: refreshToken
  };
}

function pruneFinishedTasks() {
  const now = Date.now();
  const finished = [];
  for (const [id, task] of tasks) {
    if (task.status === "completed" || task.status === "cancelled") {
      finished.push([id, task.finished_at ? Date.parse(task.finished_at) : now]);
    }
  }

  for (const [id, finishedAt] of finished) {
    if (now - finishedAt > TASK_RETENTION_MS) {
      tasks.delete(id);
    }
  }

  if (tasks.size > MAX_TASKS_KEPT) {
    const sorted = [...tasks.entries()].sort((a, b) => {
      const at = Date.parse(a[1].started_at || 0);
      const bt = Date.parse(b[1].started_at || 0);
      return at - bt;
    });
    while (tasks.size > MAX_TASKS_KEPT && sorted.length) {
      const [oldestId, oldestTask] = sorted.shift();
      if (oldestTask.status !== "running") {
        tasks.delete(oldestId);
      }
    }
  }
}

function summarizeTask(task) {
  return {
    id: task.id,
    status: task.status,
    total: task.total,
    processed: task.processed,
    ok_count: task.ok_count,
    fail_count: task.fail_count,
    auto_disabled_count: task.auto_disabled_count,
    auto_disable: task.auto_disable,
    concurrency: task.concurrency,
    started_at: task.started_at,
    finished_at: task.finished_at,
    cancel_requested: task.cancel_requested,
    last_message: task.last_message,
    last_error: task.last_error
  };
}

function serializeTask(task, { includeResults = true } = {}) {
  const summary = summarizeTask(task);
  if (!includeResults) {
    return summary;
  }

  return {
    ...summary,
    results: task.results
  };
}

export function getMailboxCheckTask(taskId) {
  return tasks.get(String(taskId)) || null;
}

export function getMailboxCheckTaskSummary(taskId) {
  const task = getMailboxCheckTask(taskId);
  return task ? serializeTask(task, { includeResults: true }) : null;
}

export function listMailboxCheckTasks() {
  pruneFinishedTasks();
  return [...tasks.values()]
    .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))
    .map((task) => serializeTask(task, { includeResults: false }));
}

export function cancelMailboxCheckTask(taskId) {
  const task = getMailboxCheckTask(taskId);
  if (!task) {
    return null;
  }

  if (task.status === "running") {
    task.cancel_requested = true;
    task.last_message = "已请求停止任务";
  }

  return serializeTask(task, { includeResults: false });
}

export function startMailboxCheckTask({
  inventoryIds = null,
  filters = null,
  concurrency = DEFAULT_CONCURRENCY,
  autoDisable = false
} = {}) {
  pruneFinishedTasks();

  const safeConcurrency = Math.min(
    MAX_CONCURRENCY,
    Math.max(1, Number(concurrency) || DEFAULT_CONCURRENCY)
  );

  const items = inventoryIds?.length
    ? getRedeemInventoryByIds(inventoryIds)
    : [];

  if (filters && !inventoryIds?.length) {
    throw new Error("批量检测需要提供库存 ID 列表");
  }

  const targets = items
    .map((item) => {
      const credentials = extractMailboxCredentials(item.payload || {});
      if (!credentials) {
        return null;
      }
      return {
        inventory_id: item.id,
        type_id: item.type_id,
        type_name: item.type_name,
        status: item.status,
        credentials
      };
    })
    .filter(Boolean);

  if (!targets.length) {
    throw new Error("未找到可检测的邮箱库存（仅支持包含邮箱凭据的记录）");
  }

  const id = randomUUID();
  const startedAt = new Date().toISOString();
  const task = {
    id,
    status: "running",
    total: targets.length,
    processed: 0,
    ok_count: 0,
    fail_count: 0,
    auto_disabled_count: 0,
    auto_disable: Boolean(autoDisable),
    concurrency: safeConcurrency,
    started_at: startedAt,
    finished_at: null,
    cancel_requested: false,
    last_message: "",
    last_error: "",
    results: []
  };

  tasks.set(id, task);
  void runTask(task, targets);
  return serializeTask(task, { includeResults: false });
}

async function runTask(task, targets) {
  const startedAt = performance.now();
  let cursor = 0;

  async function worker() {
    while (cursor < targets.length && !task.cancel_requested) {
      const index = cursor;
      cursor += 1;
      const target = targets[index];
      const result = {
        inventory_id: target.inventory_id,
        type_id: target.type_id,
        type_name: target.type_name,
        email: target.credentials.email,
        status: target.status,
        ok: false,
        stage: "",
        message: "",
        duration_ms: 0,
        auto_disabled: false,
        checked_at: new Date().toISOString()
      };

      try {
        const probe = await probeMailboxAvailability(target.credentials);
        result.ok = Boolean(probe.ok);
        result.stage = probe.stage || (probe.ok ? "ok" : "unknown");
        result.message = probe.message || (probe.ok ? "连接成功" : "失败");
        result.duration_ms = Math.round(probe.durationMs || 0);

        if (probe.ok) {
          task.ok_count += 1;
        } else {
          task.fail_count += 1;
          if (task.auto_disable && target.status === "available") {
            try {
              updateRedeemInventoryStatus(target.inventory_id, "unavailable");
              result.auto_disabled = true;
              task.auto_disabled_count += 1;
            } catch (error) {
              logger.warn("auto_disable_failed", {
                inventoryId: target.inventory_id,
                error
              });
            }
          }
        }
      } catch (error) {
        task.fail_count += 1;
        result.ok = false;
        result.stage = "exception";
        result.message = error?.message || "未知错误";
        task.last_error = result.message;
        logger.warn("probe_exception", {
          inventoryId: target.inventory_id,
          error
        });
      }

      task.processed += 1;
      task.last_message = `${result.email}: ${result.message}`;
      task.results.push(result);
    }
  }

  const concurrency = Math.min(task.concurrency, targets.length);
  const workers = Array.from({ length: concurrency }, () => worker());

  try {
    await Promise.all(workers);
  } catch (error) {
    logger.error("task_worker_exception", { taskId: task.id, error });
    task.last_error = error?.message || "任务执行异常";
  }

  task.status = task.cancel_requested ? "cancelled" : "completed";
  task.finished_at = new Date().toISOString();
  logger.info("task_finished", {
    taskId: task.id,
    status: task.status,
    total: task.total,
    processed: task.processed,
    ok: task.ok_count,
    fail: task.fail_count,
    durationMs: elapsedMs(startedAt)
  });
}
