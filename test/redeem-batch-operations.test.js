import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dbPath = path.join(
  os.tmpdir(),
  `redeem-batch-${process.pid}-${Date.now()}.db`,
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

const type = db.ensureDefaultRedeemEmailType();
const parsed = parseInventoryImportText({
  text: Array.from(
    { length: 12 },
    (_, index) => `batch${index + 1}@example.com----pw${index + 1}----client----rt${index + 1}`,
  ).join("\n"),
  field_schema: type.field_schema,
  import_delimiter: type.import_delimiter,
});
db.importRedeemInventory({
  type_id: type.id,
  items: parsed.items,
  mail_protocols: type.mail_protocols,
});

test("inventory batch update by status is idempotent and reports counts", () => {
  const ids = db.getRedeemInventoryIds({ status: "available" });
  assert.equal(ids.length, 12);

  const first = db.updateRedeemInventoryBatch(ids, { status: "unavailable" });
  assert.deepEqual(
    {
      updated: first.updated_count,
      skipped: first.skipped_count,
      total: first.total_count,
    },
    { updated: 12, skipped: 0, total: 12 },
  );

  const second = db.updateRedeemInventoryBatch(ids, { status: "unavailable" });
  assert.equal(second.updated_count, 0);
  assert.equal(second.skipped_count, 12);

  // 不存在的 id 记入 skipped，不影响已更新计数。
  const third = db.updateRedeemInventoryBatch([...ids, 999999], {
    status: "available",
  });
  assert.equal(third.updated_count, 12);
  assert.equal(third.skipped_count, 1);
  assert.equal(third.total_count, 13);
});

test("inventory batch update skips redeemed rows", () => {
  const [code] = db.createRedeemCodes({
    type_id: type.id,
    count: 1,
    quantity: 2,
  });
  db.redeemByCode({ code: code.code, requester_ip: "203.0.113.1" });

  const allIds = db.getRedeemInventoryIds({});
  const result = db.updateRedeemInventoryBatch(allIds, { status: "unavailable" });
  const redeemedCount = db.db
    .prepare("SELECT COUNT(*) AS c FROM redeem_inventory WHERE status = 'redeemed'")
    .get().c;

  assert.equal(redeemedCount, 2);
  assert.equal(result.updated_count, allIds.length - redeemedCount);
  assert.equal(result.skipped_count, redeemedCount);
});

test("inventory batch delete removes every requested row", () => {
  const ids = db.getRedeemInventoryIds({});
  assert.equal(ids.length, 12);

  const targets = ids.slice(0, 5);
  assert.equal(db.deleteRedeemInventoryBatch(targets), 5);
  assert.equal(db.getRedeemInventoryPaged({ page: 1, page_size: 1 }).total, 7);

  // 还原可用状态，供后续用例继续兑换。
  db.db
    .prepare("UPDATE redeem_inventory SET status = 'available' WHERE status = 'unavailable'")
    .run();
});

test("code batch update skips redeemed codes and same-value no-ops", () => {
  const created = db.createRedeemCodes({
    type_id: type.id,
    count: 6,
    quantity: 1,
  });
  const ids = created.map((item) => item.id);

  const quantityUpdate = db.updateRedeemCodeBatch(ids, { quantity: 3 });
  assert.equal(quantityUpdate.updated_count, 6);
  assert.equal(quantityUpdate.skipped_count, 0);

  const idSet = new Set(ids);
  const touched = db
    .getRedeemCodesPaged({ page: 1, page_size: 50 })
    .items.filter((item) => idSet.has(item.id));
  assert.equal(touched.length, 6);
  assert.ok(touched.every((item) => item.quantity === 3));

  const sameQuantity = db.updateRedeemCodeBatch(ids, { quantity: 3 });
  assert.equal(sameQuantity.updated_count, 0);
  assert.equal(sameQuantity.skipped_count, 6);

  const sameType = db.updateRedeemCodeBatch(ids, { type_id: type.id });
  assert.equal(sameType.updated_count, 0);
  assert.equal(sameType.skipped_count, 6);

  // 已兑换的卡密必须跳过改状态
  db.redeemByCode({ code: created[0].code, requester_ip: "203.0.113.2" });
  const statusUpdate = db.updateRedeemCodeStatusBatch(ids, "disabled");
  assert.equal(statusUpdate.updated_count, 5);
  assert.equal(statusUpdate.skipped_count, 1);
});

test("code batch delete skips redeemed codes", () => {
  const allCodes = db.getRedeemCodeIds({});
  const redeemedIds = new Set(
    db.db
      .prepare("SELECT id FROM redeem_codes WHERE status = 'redeemed'")
      .all()
      .map((row) => Number(row.id)),
  );

  const result = db.deleteRedeemCodeBatch(allCodes);
  assert.equal(result.total_count, allCodes.length);
  assert.equal(result.deleted_count, allCodes.length - redeemedIds.size);
  assert.equal(result.skipped_count, redeemedIds.size);

  const remaining = db.getRedeemCodesPaged({ page: 1, page_size: 50 });
  assert.equal(remaining.total, redeemedIds.size);
  assert.ok(remaining.items.every((item) => item.status === "redeemed"));
});
