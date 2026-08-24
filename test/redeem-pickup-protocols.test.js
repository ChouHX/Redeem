import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dbPath = path.join(
  os.tmpdir(),
  `redeem-pickup-protocols-${process.pid}-${Date.now()}.db`,
);

process.env.DB_PATH = dbPath;

const db = await import("../src/db.js");
const {
  collectRedeemedMailProtocols,
  formatRedeemedInventory,
  parseInventoryImportText,
} = await import("../src/redeem.js");

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

function createDualProtocolType() {
  const type = db.ensureDefaultRedeemEmailType();
  db.updateRedeemEmailType(type.id, {
    ...type,
    mail_protocols: ["imap", "graph"],
  });
  return db.getRedeemEmailTypeById(type.id);
}

function importDualProtocolAccount(type, account) {
  const parsed = parseInventoryImportText({
    text: account,
    field_schema: type.field_schema,
    import_delimiter: type.import_delimiter,
  });
  db.importRedeemInventory({
    type_id: type.id,
    items: parsed.items,
    mail_protocols: ["imap", "graph"],
  });
}

test("redeeming keeps every pickup protocol the account supports", () => {
  const type = createDualProtocolType();
  importDualProtocolAccount(type, "dual@example.com----pass----client----refresh");
  const [code] = db.createRedeemCodes({
    type_id: type.id,
    count: 1,
    quantity: 1,
  });

  const result = db.redeemByCode({ code: code.code, requester_ip: "192.0.2.1" });

  assert.deepEqual(result.inventories[0].mail_protocols, ["imap", "graph"]);
  assert.deepEqual(
    collectRedeemedMailProtocols(result.inventories, result.type),
    ["imap", "graph"],
  );

  const publicItem = formatRedeemedInventory(
    {
      ...result.type,
      mail_protocols: result.inventories[0].mail_protocols,
    },
    result.inventories[0].payload,
  );
  assert.deepEqual(publicItem.mail_protocols, ["imap", "graph"]);
  assert.deepEqual(publicItem.type.mail_protocols, ["imap", "graph"]);

  const [record] = db.getRedeemRecordsByCodeId(result.code.id);
  assert.deepEqual(record.mail_protocols, ["imap", "graph"]);

  const [inventory] = db.getRedeemInventoryByIds([
    result.inventories[0].id,
  ]);
  assert.equal(inventory.status, "redeemed");
  assert.deepEqual(inventory.mail_protocols, ["imap", "graph"]);
});

test("an import without an explicit protocol keeps all protocols allowed by the type", () => {
  const type = createDualProtocolType();
  const parsed = parseInventoryImportText({
    text: "default-dual@example.com----pass----client----refresh",
    field_schema: type.field_schema,
    import_delimiter: type.import_delimiter,
  });
  db.importRedeemInventory({
    type_id: type.id,
    items: parsed.items,
  });
  const [code] = db.createRedeemCodes({
    type_id: type.id,
    count: 1,
    quantity: 1,
  });

  const result = db.redeemByCode({ code: code.code });

  assert.deepEqual(result.inventories[0].mail_protocols, ["imap", "graph"]);
});

test("reimporting an existing account repairs narrowed protocol metadata", () => {
  const type = createDualProtocolType();
  const parsed = parseInventoryImportText({
    text: "repair-dual@example.com----pass----client----refresh",
    field_schema: type.field_schema,
    import_delimiter: type.import_delimiter,
  });
  db.importRedeemInventory({
    type_id: type.id,
    items: parsed.items,
    mail_protocols: ["imap"],
  });
  const [code] = db.createRedeemCodes({
    type_id: type.id,
    count: 1,
    quantity: 1,
  });
  const redeemed = db.redeemByCode({ code: code.code });
  assert.deepEqual(redeemed.inventories[0].mail_protocols, ["imap"]);

  const repaired = db.importRedeemInventory({
    type_id: type.id,
    items: parsed.items,
    mail_protocols: ["imap", "graph"],
  });

  assert.equal(repaired.added_count, 0);
  assert.equal(repaired.protocols_updated_count, 1);
  assert.equal(repaired.skipped_count, 1);
  const [record] = db.getRedeemRecordsByCodeId(redeemed.code.id);
  assert.deepEqual(record.mail_protocols, ["imap", "graph"]);
});

test("rollback returns the account to stock with both protocols intact", () => {
  const type = createDualProtocolType();
  importDualProtocolAccount(
    type,
    "rollback-dual@example.com----pass----client----refresh",
  );
  const [code] = db.createRedeemCodes({
    type_id: type.id,
    count: 1,
    quantity: 1,
  });

  const result = db.redeemByCode({ code: code.code, requester_ip: "192.0.2.2" });
  const inventoryId = result.inventories[0].id;
  db.rollbackRedeemCode(result.code.id);

  const [inventory] = db.getRedeemInventoryByIds([inventoryId]);
  assert.equal(inventory.status, "available");
  assert.deepEqual(inventory.mail_protocols, ["imap", "graph"]);

  const typeAfter = db
    .getRedeemEmailTypes()
    .find((item) => item.id === type.id);
  assert.equal(typeAfter.available_inventory_by_protocol.imap, 1);
  assert.equal(typeAfter.available_inventory_by_protocol.graph, 1);
});

test("a narrower account keeps its single protocol", () => {
  const base = db.ensureDefaultRedeemEmailType();
  const type = db.createRedeemEmailType({
    slug: "graph-only-type",
    name: "Graph Only",
    description: "",
    field_schema: base.field_schema,
    mail_protocol: "graph",
    mail_protocols: ["imap", "graph"],
    import_delimiter: base.import_delimiter,
    is_active: true,
  });
  const parsed = parseInventoryImportText({
    text: "graph-only@example.com----pass----client----refresh",
    field_schema: type.field_schema,
    import_delimiter: type.import_delimiter,
  });
  db.importRedeemInventory({
    type_id: type.id,
    items: parsed.items,
    mail_protocols: ["graph"],
  });
  const [code] = db.createRedeemCodes({
    type_id: type.id,
    count: 1,
    quantity: 1,
  });

  const result = db.redeemByCode({ code: code.code, requester_ip: "192.0.2.3" });

  assert.deepEqual(result.inventories[0].mail_protocols, ["graph"]);
  assert.deepEqual(
    collectRedeemedMailProtocols(result.inventories, result.type),
    ["graph"],
  );
});

test("protocol aggregation falls back to the type only for legacy rows without metadata", () => {
  assert.deepEqual(
    collectRedeemedMailProtocols(
      [{ mail_protocols: [] }],
      { mail_protocols: ["imap", "graph"] },
    ),
    ["imap", "graph"],
  );
});

test("protocol aggregation returns the union across all redeemed accounts", () => {
  assert.deepEqual(
    collectRedeemedMailProtocols(
      [
        { mail_protocols: ["imap"] },
        { mail_protocols: ["imap", "graph"] },
      ],
      { mail_protocols: ["imap", "graph"] },
    ),
    ["imap", "graph"],
  );
});
