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
