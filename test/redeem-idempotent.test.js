import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dbPath = path.join(
  os.tmpdir(),
  `redeem-idempotent-${process.pid}-${Date.now()}.db`
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
      // Temporary test database files may not all exist on every platform.
    }
  }
});

test("redeeming an already redeemed code returns the original redemption", () => {
  const type = db.ensureDefaultRedeemEmailType();
  const parsed = parseInventoryImportText({
    text: [
      "user1@example.com----pass1----client1----refresh1",
      "user2@example.com----pass2----client2----refresh2"
    ].join("\n"),
    field_schema: type.field_schema,
    import_delimiter: type.import_delimiter
  });

  db.importRedeemInventory({
    type_id: type.id,
    items: parsed.items
  });

  const [code] = db.createRedeemCodes({
    type_id: type.id,
    count: 1,
    quantity: 1
  });

  const first = db.redeemByCode({
    code: code.code,
    requester_ip: "192.0.2.1"
  });
  const second = db.redeemByCode({
    code: code.code,
    requester_ip: "192.0.2.2"
  });
  const overview = db.getRedeemAdminOverview();

  assert.deepEqual(second.record_ids, first.record_ids);
  assert.deepEqual(
    second.inventories.map((inventory) => inventory.payload.raw_line),
    first.inventories.map((inventory) => inventory.payload.raw_line)
  );
  assert.equal(second.redeemed_count, first.redeemed_count);
  assert.equal(overview.available_inventory_count, 1);
  assert.equal(overview.redeemed_inventory_count, 1);
  assert.equal(overview.record_count, 1);
});

test("rolling back a redeemed code destroys it and restores inventory", () => {
  const type = db.ensureDefaultRedeemEmailType();
  const parsed = parseInventoryImportText({
    text: "rollback@example.com----pass----client----refresh",
    field_schema: type.field_schema,
    import_delimiter: type.import_delimiter
  });
  db.importRedeemInventory({ type_id: type.id, items: parsed.items });
  const [code] = db.createRedeemCodes({
    type_id: type.id,
    count: 1,
    quantity: 1
  });
  const redeemed = db.redeemByCode({ code: code.code });

  const result = db.rollbackRedeemCode(redeemed.code.id);
  const restored = db.getRedeemInventoryByIds([
    redeemed.inventories[0].id
  ])[0];

  assert.equal(result.code, code.code);
  assert.equal(result.restored_inventory_count, 1);
  assert.equal(result.deleted_record_count, 1);
  assert.equal(db.getRedeemCodeByCode(code.code), null);
  assert.equal(restored.status, "available");
  assert.equal(restored.redeemed_code_id, null);
  assert.equal(restored.redeemed_at, null);
});

test("redeemed account data is purged after the 24 hour access window", () => {
  const type = db.ensureDefaultRedeemEmailType();
  const parsed = parseInventoryImportText({
    text: "expired@example.com----pass----client----refresh",
    field_schema: type.field_schema,
    import_delimiter: type.import_delimiter
  });
  db.importRedeemInventory({ type_id: type.id, items: parsed.items });
  const [code] = db.createRedeemCodes({
    type_id: type.id,
    count: 1,
    quantity: 1
  });
  const redeemed = db.redeemByCode({ code: code.code });
  const historyJob = db.createTokenCheckJob({
    id: "expired-history-check",
    type_id: type.id,
    inventory_status: "redeemed",
    total_count: 1
  });
  db.appendTokenCheckResult(historyJob.id, {
    inventory_id: redeemed.inventories[0].id,
    email: "expired@example.com",
    serialized_value: "expired@example.com----pass----client----refresh",
    protocol: "imap",
    outcome: "live"
  });
  const oldRedeemedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  const sqliteUtcTimestamp = oldRedeemedAt.slice(0, 19).replace("T", " ");
  assert.equal(db.isRedeemAccessExpired(sqliteUtcTimestamp), true);
  db.db
    .prepare(
      "UPDATE redeem_codes SET redeemed_at = ? WHERE id = ?"
    )
    .run(oldRedeemedAt, redeemed.code.id);
  db.db
    .prepare(
      "UPDATE redeem_inventory SET redeemed_at = ? WHERE redeemed_code_id = ?"
    )
    .run(oldRedeemedAt, redeemed.code.id);

  const purged = db.purgeExpiredRedeemDataByCodeId(redeemed.code.id);
  const expiredCode = db.getRedeemCodeByCode(code.code);

  assert.equal(purged.deleted_inventory_count, 1);
  assert.equal(purged.deleted_record_count, 1);
  assert.equal(expiredCode.data_deleted_reason, "expired_24h");
  assert.equal(db.getRedeemInventoryByIds([redeemed.inventories[0].id]).length, 0);
  assert.equal(db.getRedeemRecordsByCodeId(redeemed.code.id).length, 0);
  assert.deepEqual(db.getTokenCheckResultLines(historyJob.id, "live"), []);
  assert.throws(
    () => db.redeemByCode({ code: code.code }),
    /账号信息已删除/
  );
});

test("token check jobs persist separated live, expired, and error statistics", () => {
  const type = db.ensureDefaultRedeemEmailType();
  const job = db.createTokenCheckJob({
    id: "test-token-check",
    type_id: type.id,
    inventory_status: "available",
    total_count: 3
  });
  assert.equal(job.status, "running");

  db.appendTokenCheckResult(job.id, {
    inventory_id: 1001,
    email: "live@example.com",
    serialized_value: "live-line",
    protocol: "imap",
    outcome: "live"
  });
  db.appendTokenCheckResult(job.id, {
    inventory_id: 1002,
    email: "expired@example.com",
    serialized_value: "expired-line",
    protocol: "graph",
    outcome: "expired",
    error_code: "AADSTS700082"
  });
  db.appendTokenCheckResult(job.id, {
    inventory_id: 1003,
    email: "error@example.com",
    serialized_value: "error-line",
    protocol: "imap",
    outcome: "error",
    error_code: "AADSTS700016"
  });
  const completed = db.completeTokenCheckJob(job.id);

  assert.equal(completed.processed_count, 3);
  assert.equal(completed.live_count, 1);
  assert.equal(completed.expired_count, 1);
  assert.equal(completed.error_count, 1);
  assert.deepEqual(completed.error_codes, { AADSTS700016: 1 });
  assert.deepEqual(db.getTokenCheckResultLines(job.id, "live"), ["live-line"]);
  assert.deepEqual(db.getTokenCheckResultLines(job.id, "expired"), [
    "expired-line"
  ]);

  const parsed = parseInventoryImportText({
    text: "delete-after-check@example.com----pass----client----refresh",
    field_schema: type.field_schema,
    import_delimiter: type.import_delimiter
  });
  db.importRedeemInventory({ type_id: type.id, items: parsed.items });
  const inventory = db.getRedeemInventoryPaged({
    type_id: type.id,
    q: "delete-after-check@example.com",
    page_size: 10
  }).items[0];
  const deleteJob = db.createTokenCheckJob({
    id: "test-token-check-delete",
    type_id: type.id,
    inventory_status: "available",
    total_count: 1
  });
  db.appendTokenCheckResult(deleteJob.id, {
    inventory_id: inventory.id,
    email: "delete-after-check@example.com",
    serialized_value: inventory.serialized_value,
    protocol: "imap",
    outcome: "expired",
    error_code: "AADSTS700082"
  });

  assert.equal(db.deleteTokenCheckAbnormalInventory(deleteJob.id), 1);
  assert.equal(db.getRedeemInventoryByIds([inventory.id]).length, 0);
});
