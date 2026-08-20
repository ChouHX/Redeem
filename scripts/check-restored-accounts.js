import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import { classifyOauthFailure } from "../src/token-check.js";
import { parseMailboxAccountLine } from "../src/redeem.js";

const TARGET_SLUGS = ["outlook-oauth", "hotmail-oauth", "none"];
const DEFAULT_CLIENT_ID = "dbc8e03a-b00c-46bd-ae65-b683e7707cb0";
const DEFAULT_TOKEN_URL =
  "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
const DEFAULT_SCOPE =
  "https://outlook.office.com/IMAP.AccessAsUser.All offline_access";

function parsePositiveInt(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.min(parsed, maximum);
}

export function parseArgs(argv) {
  const options = {
    db: "server_data/outlook_manager-restored.db",
    output: "server_data/token-check-restored",
    concurrency: parsePositiveInt(process.env.TOKEN_CHECK_CONCURRENCY, 8, 32),
    timeoutMs: parsePositiveInt(process.env.TOKEN_CHECK_TIMEOUT_MS, 15000, 120000),
    batchSize: 500,
    dryRun: false,
    exportOnly: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];
    if (argument === "--") {
      continue;
    } else if (argument === "--db" && next) {
      options.db = next;
      index += 1;
    } else if (argument === "--output" && next) {
      options.output = next;
      index += 1;
    } else if (argument === "--concurrency" && next) {
      options.concurrency = parsePositiveInt(next, options.concurrency, 32);
      index += 1;
    } else if (argument === "--timeout-ms" && next) {
      options.timeoutMs = parsePositiveInt(next, options.timeoutMs, 120000);
      index += 1;
    } else if (argument === "--batch-size" && next) {
      options.batchSize = parsePositiveInt(next, options.batchSize, 5000);
      index += 1;
    } else if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument === "--export-only") {
      options.exportOnly = true;
    } else {
      throw new Error(`未知参数: ${argument}`);
    }
  }

  options.db = path.resolve(options.db);
  options.output = path.resolve(options.output);
  return options;
}

function sha256File(filename) {
  const hash = crypto.createHash("sha256");
  const file = fs.openSync(filename, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(file, buffer, 0, buffer.length, null);
      if (bytesRead) {
        hash.update(buffer.subarray(0, bytesRead));
      }
    } while (bytesRead);
  } finally {
    fs.closeSync(file);
  }
  return hash.digest("hex");
}

function replaceRefreshToken(serializedValue, refreshToken) {
  const parts = String(serializedValue || "").split("----");
  if (parts.length >= 4) {
    return [parts[0], parts[1], parts[2], refreshToken].join("----");
  }
  if (parts.length >= 2) {
    return [parts[0], refreshToken].join("----");
  }
  return serializedValue;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function checkCandidate(candidate, options) {
  const checkedAt = new Date().toISOString();
  const credentials = parseMailboxAccountLine(
    candidate.serialized_value,
    DEFAULT_CLIENT_ID,
  );
  const baseResult = {
    inventory_id: candidate.inventory_id,
    type_id: candidate.type_id,
    type_slug: candidate.type_slug,
    inventory_status: candidate.inventory_status,
    serialized_value: candidate.serialized_value,
    checked_at: checkedAt,
  };

  if (!credentials?.email || !credentials?.refresh_token) {
    return {
      ...baseResult,
      outcome: "error",
      error_code: "PARSE_ERROR",
      error_message: "库存数据无法解析为邮箱 Refresh Token 凭据",
    };
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const body = new URLSearchParams({
        client_id: String(credentials.client_id || DEFAULT_CLIENT_ID),
        grant_type: "refresh_token",
        refresh_token: String(credentials.refresh_token),
        scope: process.env.IMAP_OAUTH_SCOPE || DEFAULT_SCOPE,
      });
      const response = await fetch(process.env.TOKEN_URL || DEFAULT_TOKEN_URL, {
        method: "POST",
        body,
        signal: controller.signal,
      });
      const bodyText = await response.text();
      let payload = null;
      try {
        payload = bodyText ? JSON.parse(bodyText) : null;
      } catch {
        payload = null;
      }

      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      if (!response.ok || !payload?.access_token) {
        return {
          ...baseResult,
          ...classifyOauthFailure(payload, bodyText, response.status),
        };
      }

      return {
        ...baseResult,
        outcome: "live",
        error_code: "",
        error_message: "",
        serialized_value: payload.refresh_token
          ? replaceRefreshToken(candidate.serialized_value, String(payload.refresh_token))
          : candidate.serialized_value,
      };
    } catch (error) {
      if (attempt < 2) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      return {
        ...baseResult,
        outcome: "error",
        error_code: error?.name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR",
        error_message:
          error?.name === "AbortError"
            ? `Token 检测超过 ${options.timeoutMs}ms`
            : String(error?.message || "Token 检测请求失败"),
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw new Error("检测重试状态异常");
}

async function mapConcurrent(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

function openResultsDatabase(filename) {
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS results (
      inventory_id INTEGER PRIMARY KEY,
      type_id INTEGER NOT NULL,
      type_slug TEXT NOT NULL,
      inventory_status TEXT NOT NULL,
      outcome TEXT NOT NULL,
      error_code TEXT NOT NULL DEFAULT '',
      error_message TEXT NOT NULL DEFAULT '',
      serialized_value TEXT NOT NULL,
      checked_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_results_outcome ON results(outcome);
    CREATE INDEX IF NOT EXISTS idx_results_type_outcome
      ON results(type_slug, outcome);
  `);
  return db;
}

function exportResults(resultsDb, outputDirectory, totalCount, sourceHash) {
  const counts = Object.fromEntries(
    resultsDb
      .prepare("SELECT outcome, COUNT(*) count FROM results GROUP BY outcome")
      .all()
      .map((row) => [row.outcome, Number(row.count)]),
  );
  for (const outcome of ["live", "expired", "error"]) {
    const filename = path.join(outputDirectory, `${outcome}.txt`);
    const descriptor = fs.openSync(filename, "w", 0o600);
    try {
      for (const row of resultsDb
        .prepare(
          "SELECT serialized_value FROM results WHERE outcome = ? ORDER BY inventory_id",
        )
        .iterate(outcome)) {
        fs.writeSync(descriptor, `${row.serialized_value}\n`);
      }
    } finally {
      fs.closeSync(descriptor);
    }
  }

  const processed = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const summary = {
    source_sha256: sourceHash,
    target_type_slugs: TARGET_SLUGS,
    total: totalCount,
    processed,
    pending: Math.max(0, totalCount - processed),
    live: counts.live || 0,
    expired: counts.expired || 0,
    error: counts.error || 0,
    exported_at: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(outputDirectory, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    { mode: 0o600 },
  );
  return summary;
}

export async function run(options) {
  if (!fs.existsSync(options.db)) {
    throw new Error(`数据库不存在: ${options.db}`);
  }
  const sourceDb = new Database(options.db, { readonly: true, fileMustExist: true });
  const placeholders = TARGET_SLUGS.map(() => "?").join(", ");
  const totalCount = Number(
    sourceDb
      .prepare(
        `SELECT COUNT(*) count
         FROM redeem_inventory inventory
         JOIN redeem_email_types types ON types.id = inventory.type_id
         WHERE types.slug IN (${placeholders})`,
      )
      .get(...TARGET_SLUGS).count,
  );

  if (options.dryRun) {
    sourceDb.close();
    return { total: totalCount, target_type_slugs: TARGET_SLUGS };
  }

  fs.mkdirSync(options.output, { recursive: true, mode: 0o700 });
  const sourceHash = sha256File(options.db);
  const resultsDb = openResultsDatabase(path.join(options.output, "results.db"));
  const existingHash = resultsDb
    .prepare("SELECT value FROM metadata WHERE key = 'source_sha256'")
    .get()?.value;
  if (existingHash && existingHash !== sourceHash) {
    sourceDb.close();
    resultsDb.close();
    throw new Error("结果目录属于另一个数据库，请更换 --output 目录");
  }
  resultsDb
    .prepare("INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)")
    .run("source_sha256", sourceHash);

  if (!options.exportOnly) {
    const selectBatch = sourceDb.prepare(
      `SELECT
         inventory.id AS inventory_id,
         inventory.type_id,
         types.slug AS type_slug,
         inventory.status AS inventory_status,
         inventory.serialized_value
       FROM redeem_inventory inventory
       JOIN redeem_email_types types ON types.id = inventory.type_id
       WHERE types.slug IN (${placeholders}) AND inventory.id > ?
       ORDER BY inventory.id ASC
       LIMIT ?`,
    );
    const hasResult = resultsDb.prepare(
      "SELECT 1 FROM results WHERE inventory_id = ? LIMIT 1",
    );
    const insertResult = resultsDb.prepare(
      `INSERT OR REPLACE INTO results (
         inventory_id, type_id, type_slug, inventory_status, outcome,
         error_code, error_message, serialized_value, checked_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertBatch = resultsDb.transaction((rows) => {
      for (const row of rows) {
        insertResult.run(
          row.inventory_id,
          row.type_id,
          row.type_slug,
          row.inventory_status,
          row.outcome,
          row.error_code,
          row.error_message,
          row.serialized_value,
          row.checked_at,
        );
      }
    });

    let lastId = 0;
    let completed = Number(resultsDb.prepare("SELECT COUNT(*) count FROM results").get().count);
    while (true) {
      const batch = selectBatch.all(...TARGET_SLUGS, lastId, options.batchSize);
      if (!batch.length) {
        break;
      }
      lastId = batch.at(-1).inventory_id;
      const pending = batch.filter((candidate) => !hasResult.get(candidate.inventory_id));
      if (!pending.length) {
        continue;
      }
      const checked = await mapConcurrent(pending, options.concurrency, (candidate) =>
        checkCandidate(candidate, options),
      );
      insertBatch(checked);
      completed += checked.length;
      process.stdout.write(
        `${new Date().toISOString()} processed=${completed}/${totalCount}\n`,
      );
    }
  }

  const summary = exportResults(resultsDb, options.output, totalCount, sourceHash);
  sourceDb.close();
  resultsDb.close();
  return summary;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await run(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${String(error?.stack || error)}\n`);
    process.exitCode = 1;
  });
}
