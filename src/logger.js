import { performance } from "node:perf_hooks";
import { LOG_LEVEL } from "./config.js";

const LOG_LEVEL_WEIGHT = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const ACTIVE_LOG_LEVEL = LOG_LEVEL_WEIGHT[LOG_LEVEL] ? LOG_LEVEL : "info";

function shouldLog(level) {
  return LOG_LEVEL_WEIGHT[level] >= LOG_LEVEL_WEIGHT[ACTIVE_LOG_LEVEL];
}

function normalizeValue(value) {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack
    };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeValue(entry));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, normalizeValue(entry)])
  );
}

function writeLog(level, scope, event, context = {}) {
  if (!shouldLog(level)) {
    return;
  }

  const payload = {
    ts: new Date().toISOString(),
    level,
    scope,
    event,
    ...normalizeValue(context)
  };

  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
    return;
  }

  if (level === "warn") {
    console.warn(line);
    return;
  }

  console.log(line);
}

export function createLogger(scope, baseContext = {}) {
  return {
    debug(event, context = {}) {
      writeLog("debug", scope, event, { ...baseContext, ...context });
    },
    info(event, context = {}) {
      writeLog("info", scope, event, { ...baseContext, ...context });
    },
    warn(event, context = {}) {
      writeLog("warn", scope, event, { ...baseContext, ...context });
    },
    error(event, context = {}) {
      writeLog("error", scope, event, { ...baseContext, ...context });
    },
    child(context = {}) {
      return createLogger(scope, { ...baseContext, ...context });
    }
  };
}

export function elapsedMs(startedAt) {
  return Number((performance.now() - startedAt).toFixed(1));
}
