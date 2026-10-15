// 查询性能基准脚本（临时工具）：造 13w 行数据并计时各查询路径。
// 用法：node scripts/bench-queries.mjs
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const BENCH_DIR = process.env.BENCH_DIR || path.join(os.tmpdir(), "redeem-bench");
fs.rmSync(BENCH_DIR, { recursive: true, force: true });
fs.mkdirSync(BENCH_DIR, { recursive: true });

process.env.DB_PATH = path.join(BENCH_DIR, "bench.db");

const INVENTORY_COUNT = Number(process.env.BENCH_INVENTORY || 130000);
const CODE_COUNT = Number(process.env.BENCH_CODES || 20000);

const db = await import("../src/db.js");
const { db: raw } = db;

function seed() {
  const insertType = raw.prepare(
    `INSERT INTO redeem_email_types (slug, name, description, field_schema, mail_protocol, mail_protocols, import_delimiter, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
  );
  const typeId = Number(
    insertType.run(
      "bench-type",
      "基准类型",
      "bench",
      JSON.stringify([
        { key: "account", label: "账号", required: true, sensitive: false },
        { key: "password", label: "密码", required: true, sensitive: true },
        { key: "oauth2id", label: "OAuth2 ID", required: true, sensitive: false },
        {
          key: "refreshtoken",
          label: "Refresh Token",
          required: true,
          sensitive: true,
        },
      ]),
      "imap",
      JSON.stringify(["imap", "graph"]),
      "----",
    ).lastInsertRowid,
  );

  const insertInventory = raw.prepare(
    `INSERT INTO redeem_inventory (type_id, payload_json, serialized_value, search_text, status, pickup_protocols, redeemed_code_id, redeemed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertCode = raw.prepare(
    `INSERT INTO redeem_codes (code, normalized_code, type_id, quantity, redeemed_quantity, note, status, redeemed_inventory_id, redeemed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertRecord = raw.prepare(
    `INSERT INTO redeem_records (code_id, inventory_id, type_id, code, normalized_code, payload_json, requester_ip, requester_user_agent, redeemed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const t0 = Date.now();
  raw.exec("BEGIN");
  for (let i = 1; i <= INVENTORY_COUNT; i += 1) {
    const email = `user${i}@outlook.com`;
    const payload = {
      account: email,
      password: `pw-${i}`,
      oauth2id: "dbc8e03a-b00c-46bd-ae65-b683e7707cb0",
      refreshtoken: `rt-${i}-${"x".repeat(40)}`,
    };
    const serialized = `${email}----pw-${i}----dbc8e03a-b00c-46bd-ae65-b683e7707cb0----rt-${i}-${"x".repeat(40)}`;
    const roll = i % 100;
    const status = roll < 80 ? "available" : roll < 95 ? "redeemed" : "unavailable";
    const protocols = i % 3 === 0 ? '["graph"]' : i % 3 === 1 ? '["imap"]' : '["imap","graph"]';
    insertInventory.run(
      typeId,
      JSON.stringify(payload),
      serialized,
      serialized.toLowerCase(),
      status,
      protocols,
      null,
      null,
    );
  }
  raw.exec("COMMIT");
  console.log(`inventory seeded: ${INVENTORY_COUNT} rows in ${Date.now() - t0}ms`);

  const t1 = Date.now();
  raw.exec("BEGIN");
  for (let i = 1; i <= CODE_COUNT; i += 1) {
    const code = `RD-${String(i).padStart(8, "0")}-${(i * 7919) % 100000}`;
    const status = i % 100 < 70 ? "unused" : i % 100 < 90 ? "redeemed" : "disabled";
    insertCode.run(
      code,
      code.toLowerCase(),
      typeId,
      1,
      status === "redeemed" ? 1 : 0,
      "",
      status,
      null,
      status === "redeemed" ? "2026-09-01 10:00:00" : null,
    );
  }
  raw.exec("COMMIT");
  console.log(`codes seeded: ${CODE_COUNT} rows in ${Date.now() - t1}ms`);

  const t2 = Date.now();
  const codeRows = raw
    .prepare("SELECT id, code, normalized_code FROM redeem_codes WHERE status = 'redeemed'")
    .all();
  const inventoryRows = raw
    .prepare("SELECT id, payload_json FROM redeem_inventory WHERE status = 'redeemed'")
    .all();
  raw.exec("BEGIN");
  for (let i = 0; i < inventoryRows.length; i += 1) {
    const inv = inventoryRows[i];
    const code = codeRows[i % codeRows.length];
    if (!code) break;
    insertRecord.run(
      code.id,
      inv.id,
      typeId,
      code.code,
      code.normalized_code,
      inv.payload_json,
      "203.0.113.7",
      "Mozilla/5.0",
      "2026-09-01 10:00:00",
    );
    raw
      .prepare("UPDATE redeem_inventory SET redeemed_code_id = ?, redeemed_at = ? WHERE id = ?")
      .run(code.id, "2026-09-01 10:00:00", inv.id);
  }
  raw.exec("COMMIT");
  console.log(`records seeded: ${inventoryRows.length} rows in ${Date.now() - t2}ms`);
}

let needsSeed = true;
try {
  needsSeed =
    Number(
      raw.prepare("SELECT COUNT(*) AS c FROM redeem_inventory").get()?.c || 0,
    ) < INVENTORY_COUNT;
} catch {
  needsSeed = true;
}

if (needsSeed) {
  seed();
}

raw.pragma("optimize");

const counts = {
  inventory: raw.prepare("SELECT COUNT(*) AS c FROM redeem_inventory").get().c,
  codes: raw.prepare("SELECT COUNT(*) AS c FROM redeem_codes").get().c,
  records: raw.prepare("SELECT COUNT(*) AS c FROM redeem_records").get().c,
};
console.log("counts:", counts);

function time(label, fn, runs = 3) {
  const timings = [];
  let result;
  for (let i = 0; i < runs; i += 1) {
    const start = process.hrtime.bigint();
    result = fn();
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    timings.push(ms);
  }
  const best = Math.min(...timings);
  const median = timings.sort((a, b) => a - b)[Math.floor(timings.length / 2)];
  const shape = Array.isArray(result)
    ? `array(${result.length})`
    : result && typeof result === "object"
      ? `total=${result.total ?? result.items?.length ?? "-"}`
      : String(result);
  console.log(
    `${label.padEnd(52)} best=${best.toFixed(1).padStart(9)}ms median=${median.toFixed(1).padStart(9)}ms  ${shape}`,
  );
  return { best, median };
}

console.log("\n--- 基准结果 ---");
time("getRedeemEmailTypes()", () => db.getRedeemEmailTypes());
time("getRedeemAdminOverview()", () => db.getRedeemAdminOverview());
time("inventory paged 无筛选 p1", () =>
  db.getRedeemInventoryPaged({ page: 1, page_size: 10 }),
);
time("inventory paged 仅 type_id", () =>
  db.getRedeemInventoryPaged({ type_id: "1", page: 1, page_size: 10 }),
);
time("inventory paged status=available", () =>
  db.getRedeemInventoryPaged({ status: "available", page: 1, page_size: 10 }),
);
time("inventory paged type+status", () =>
  db.getRedeemInventoryPaged({ type_id: "1", status: "available", page: 1, page_size: 10 }),
);
time("inventory paged protocol=imap", () =>
  db.getRedeemInventoryPaged({ protocol: "imap", page: 1, page_size: 10 }),
);
time("inventory paged q=user1234 (fts)", () =>
  db.getRedeemInventoryPaged({ q: "user1234", page: 1, page_size: 10 }),
);
time("inventory paged q=ab (like 短词)", () =>
  db.getRedeemInventoryPaged({ q: "ab", page: 1, page_size: 10 }),
);
time("inventory paged 深翻页 p1000", () =>
  db.getRedeemInventoryPaged({ page: 1000, page_size: 100 }),
);
time("inventory selection count", () =>
  db.getRedeemInventorySelectionCount({ status: "available" }),
);
time("inventory ids 全量", () => db.getRedeemInventoryIds({}), 1);
time("codes paged 无筛选 p1", () =>
  db.getRedeemCodesPaged({ page: 1, page_size: 10 }),
);
time("codes paged status=unused", () =>
  db.getRedeemCodesPaged({ status: "unused", page: 1, page_size: 10 }),
);
time("codes paged available", () =>
  db.getRedeemCodesPaged({ status: "available", page: 1, page_size: 10 }),
);
time("codes paged q 模糊", () =>
  db.getRedeemCodesPaged({ q: "rd-00001", page: 1, page_size: 10 }),
);
time("codes paged 深翻页 p100", () =>
  db.getRedeemCodesPaged({ page: 100, page_size: 100 }),
);
time("records paged 无筛选 p1", () =>
  db.getRedeemRecordsPaged({ page: 1, page_size: 10 }),
);
time("records paged type_id", () =>
  db.getRedeemRecordsPaged({ type_id: "1", page: 1, page_size: 10 }),
);
time("records paged q 模糊", () =>
  db.getRedeemRecordsPaged({ q: "user1234", page: 1, page_size: 10 }),
);
time("records paged 深翻页 p100", () =>
  db.getRedeemRecordsPaged({ page: 100, page_size: 100 }),
);

console.log("\n--- 正确性核对（标志列 vs json_each）---");
for (const protocol of ["imap", "graph"]) {
  const flagCount = raw
    .prepare(
      `SELECT COUNT(*) AS c FROM redeem_inventory WHERE pickup_${protocol} = 1`,
    )
    .get().c;
  const jsonCount = raw
    .prepare(
      `SELECT COUNT(*) AS c FROM redeem_inventory inventory
       WHERE EXISTS (SELECT 1 FROM json_each(inventory.pickup_protocols) WHERE value = ?)`,
    )
    .get(protocol).c;
  const flagByType = raw
    .prepare(
      `SELECT COUNT(*) AS c FROM redeem_inventory WHERE type_id = 1 AND status = 'available' AND pickup_${protocol} = 1`,
    )
    .get().c;
  const jsonByType = raw
    .prepare(
      `SELECT COUNT(*) AS c FROM redeem_inventory inventory
       WHERE type_id = 1 AND status = 'available'
         AND EXISTS (SELECT 1 FROM json_each(inventory.pickup_protocols) WHERE value = ?)`,
    )
    .get(protocol).c;
  console.log(
    `  ${protocol}: 全表 flag=${flagCount} json=${jsonCount} ${flagCount === jsonCount ? "OK" : "MISMATCH"} | ` +
      `type+available flag=${flagByType} json=${jsonByType} ${flagByType === jsonByType ? "OK" : "MISMATCH"}`,
  );
}

const mismatched = raw
  .prepare(
    `SELECT COUNT(*) AS c FROM redeem_inventory
     WHERE pickup_imap <> (instr(pickup_protocols, '"imap"') > 0)
        OR pickup_graph <> (instr(pickup_protocols, '"graph"') > 0)`,
  )
  .get().c;
console.log(`  标志列失配行数: ${mismatched}`);

if (process.env.BENCH_SKIP_MUTATION !== "1") {
  console.log("\n--- 批量操作（会改数据，放最后）---");
  const availableIds = db.getRedeemInventoryIds({ status: "available" });
  console.log(`  选中库存 id 数: ${availableIds.length}`);
  time(
    `inventory batch-update status 全量(${availableIds.length})`,
    () => db.updateRedeemInventoryBatch(availableIds, { status: "unavailable" }),
    1,
  );
  const codeIds = db.getRedeemCodeIds({});
  console.log(`  选中卡密 id 数: ${codeIds.length}`);
  time(
    `codes batch-status 全量(${codeIds.length})`,
    () => db.updateRedeemCodeStatusBatch(codeIds, "disabled"),
    1,
  );
  time(
    `inventory batch-delete 全量(${availableIds.length})`,
    () => db.deleteRedeemInventoryBatch(availableIds),
    1,
  );
}

console.log("\n--- 执行计划 ---");
const plans = [
  ["inventory paged 无筛选", "SELECT inventory.* FROM redeem_inventory inventory JOIN redeem_email_types types ON types.id = inventory.type_id ORDER BY inventory.id DESC LIMIT 10 OFFSET 0"],
  ["inventory type+status", "SELECT inventory.* FROM redeem_inventory inventory JOIN redeem_email_types types ON types.id = inventory.type_id WHERE inventory.type_id = 1 AND inventory.status = 'available' ORDER BY inventory.id DESC LIMIT 10 OFFSET 0"],
  ["inventory count type+status", "SELECT COUNT(*) AS total FROM redeem_inventory inventory WHERE inventory.type_id = 1 AND inventory.status = 'available'"],
  ["inventory protocol", "SELECT inventory.id FROM redeem_inventory inventory WHERE EXISTS (SELECT 1 FROM json_each(inventory.pickup_protocols) WHERE value = 'imap') ORDER BY inventory.id DESC LIMIT 10"],
  ["codes status=unused", "SELECT codes.* FROM redeem_codes codes JOIN redeem_email_types types ON types.id = codes.type_id WHERE codes.status = 'unused' ORDER BY codes.id DESC LIMIT 10"],
  ["codes available", "SELECT codes.* FROM redeem_codes codes JOIN redeem_email_types types ON types.id = codes.type_id WHERE codes.status = 'unused' AND (codes.expires_at IS NULL OR codes.expires_at > CURRENT_TIMESTAMP) ORDER BY codes.id DESC LIMIT 10"],
  ["records group by", "SELECT records.code_id, COUNT(records.id) FROM redeem_records records JOIN redeem_email_types types ON types.id = records.type_id LEFT JOIN redeem_inventory inventory ON inventory.id = records.inventory_id GROUP BY records.code_id ORDER BY MAX(records.id) DESC LIMIT 10"],
];
for (const [label, sql] of plans) {
  console.log(`\n[${label}]`);
  for (const row of raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all()) {
    console.log(`   ${row.detail}`);
  }
}

raw.close();
