import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dbPath = path.join(
  os.tmpdir(),
  `redeem-protocol-flags-${process.pid}-${Date.now()}.db`,
);

process.env.DB_PATH = dbPath;

const db = await import("../src/db.js");
const { parseInventoryImportText } = await import("../src/redeem.js");

after(() => {
  db.closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(`${dbPath}${suffix}`);
    } catch {
      // 临时库文件不一定全部存在。
    }
  }
});

function importItems(type, lines, mailProtocols) {
  const parsed = parseInventoryImportText({
    text: lines.join("\n"),
    field_schema: type.field_schema,
    import_delimiter: type.import_delimiter,
  });
  return db.importRedeemInventory({
    type_id: type.id,
    items: parsed.items,
    mail_protocols: mailProtocols,
  });
}

// 以 pickup_protocols 的 JSON 为准的参考实现，用来校验物化标志列。
function referenceCount(protocol, extraWhere = "", extraParams = []) {
  return db.db
    .prepare(
      `SELECT COUNT(*) AS c
       FROM redeem_inventory inventory
       WHERE EXISTS (
         SELECT 1 FROM json_each(inventory.pickup_protocols) WHERE value = ?
       ) ${extraWhere}`,
    )
    .get(protocol, ...extraParams).c;
}

test("import keeps pickup_imap / pickup_graph in sync with pickup_protocols", () => {
  const type = db.ensureDefaultRedeemEmailType();
  const updated = db.updateRedeemEmailType(type.id, {
    ...type,
    mail_protocols: ["imap", "graph"],
  });
  assert.deepEqual(updated.mail_protocols.slice().sort(), ["graph", "imap"]);

  importItems(
    updated,
    ["imap1@example.com----p1----c1----r1", "imap2@example.com----p2----c2----r2"],
    ["imap"],
  );
  importItems(
    updated,
    [
      "graph1@example.com----p1----c1----r1",
      "graph2@example.com----p2----c2----r2",
    ],
    ["graph"],
  );

  const imapRow = db.db
    .prepare(
      "SELECT pickup_imap, pickup_graph FROM redeem_inventory WHERE serialized_value = ?",
    )
    .get("imap1@example.com----p1----c1----r1");
  assert.equal(imapRow.pickup_imap, 1);
  assert.equal(imapRow.pickup_graph, 0);

  const graphRow = db.db
    .prepare(
      "SELECT pickup_imap, pickup_graph FROM redeem_inventory WHERE serialized_value = ?",
    )
    .get("graph1@example.com----p1----c1----r1");
  assert.equal(graphRow.pickup_imap, 0);
  assert.equal(graphRow.pickup_graph, 1);
});

test("the trigger repairs flags when a writer forgets to set them", () => {
  const type = db.getRedeemEmailTypes()[0];
  // 直接写库、不提供标志列，模拟第三方写入路径。
  db.db
    .prepare(
      `INSERT INTO redeem_inventory (type_id, serialized_value, status, pickup_protocols)
       VALUES (?, ?, 'available', '["graph"]')`,
    )
    .run(type.id, "raw-graph@example.com----p----c----r");

  const row = db.db
    .prepare(
      "SELECT pickup_imap, pickup_graph FROM redeem_inventory WHERE serialized_value = ?",
    )
    .get("raw-graph@example.com----p----c----r");
  assert.equal(row.pickup_imap, 0);
  assert.equal(row.pickup_graph, 1);
});

test("flag-based protocol filtering matches the JSON reference", () => {
  for (const protocol of ["imap", "graph"]) {
    const expected = referenceCount(protocol);
    const page = db.getRedeemInventoryPaged({
      protocol,
      page: 1,
      page_size: 100,
    });

    assert.equal(page.total, expected, `${protocol} 总数应与参考实现一致`);
    assert.ok(page.items.length > 0);
    assert.ok(
      page.items.every((item) => item.mail_protocols.includes(protocol)),
      `${protocol} 结果集不应混入其它协议`,
    );
  }
});

test("redeeming falls back to the second allowed protocol when the first is empty", () => {
  const type = db.getRedeemEmailTypes()[0];

  // 先清掉全部 imap 库存，只剩 graph，兑换必须落到 graph 上。
  db.db
    .prepare(
      "UPDATE redeem_inventory SET status = 'unavailable' WHERE pickup_imap = 1 AND status = 'available'",
    )
    .run();

  const [code] = db.createRedeemCodes({
    type_id: type.id,
    count: 1,
    quantity: 1,
  });
  const redeemed = db.redeemByCode({
    code: code.code,
    requester_ip: "198.51.100.9",
  });

  assert.equal(redeemed.inventories.length, 1);
  assert.deepEqual(redeemed.inventories[0].mail_protocols, ["graph"]);
});

test("batch status update and delete report accurate counts", () => {
  const totalBefore = db.getRedeemInventoryPaged({ page: 1, page_size: 1 }).total;
  const availableIds = db.getRedeemInventoryIds({ status: "available" });
  assert.ok(availableIds.length > 0);

  const updateResult = db.updateRedeemInventoryBatch(availableIds, {
    status: "unavailable",
  });
  assert.equal(updateResult.updated_count, availableIds.length);
  assert.equal(updateResult.skipped_count, 0);

  // 再执行一次：全部已是目标状态，应全部跳过。
  const secondResult = db.updateRedeemInventoryBatch(availableIds, {
    status: "unavailable",
  });
  assert.equal(secondResult.updated_count, 0);
  assert.equal(secondResult.skipped_count, availableIds.length);

  const deleted = db.deleteRedeemInventoryBatch(availableIds);
  assert.equal(deleted, availableIds.length);
  assert.equal(
    db.getRedeemInventoryPaged({ page: 1, page_size: 1 }).total,
    totalBefore - availableIds.length,
  );
});

test("batch code status update skips redeemed codes", () => {
  const allCodes = db.getRedeemCodeIds({});
  const result = db.updateRedeemCodeStatusBatch(allCodes, "disabled");

  const redeemedCount = db.db
    .prepare("SELECT COUNT(*) AS c FROM redeem_codes WHERE status = 'redeemed'")
    .get().c;
  assert.equal(result.total_count, allCodes.length);
  assert.equal(result.updated_count, allCodes.length - redeemedCount);
  assert.equal(result.skipped_count, redeemedCount);
});
