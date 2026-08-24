import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dbPath = path.join(
  os.tmpdir(),
  `redeem-filtered-selection-${process.pid}-${Date.now()}.db`,
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

function importAccount(type, line, mailProtocols) {
  const parsed = parseInventoryImportText({
    text: line,
    field_schema: type.field_schema,
    import_delimiter: type.import_delimiter,
  });
  db.importRedeemInventory({
    type_id: type.id,
    items: parsed.items,
    mail_protocols: mailProtocols,
  });
}

test("inventory filtered selection uses the same filters as the paged list", () => {
  const base = db.ensureDefaultRedeemEmailType();
  db.updateRedeemEmailType(base.id, {
    ...base,
    mail_protocols: ["imap", "graph"],
  });
  const type = db.getRedeemEmailTypeById(base.id);
  importAccount(
    type,
    "imap-match@example.com----pass----client----refresh",
    ["imap"],
  );
  importAccount(
    type,
    "graph-match@example.com----pass----client----refresh",
    ["graph"],
  );

  const filters = { type_id: type.id, protocol: "graph", q: "match" };
  const page = db.getRedeemInventoryPaged(filters);
  const ids = db.getRedeemInventoryIds(filters);

  assert.deepEqual(ids, page.items.map((item) => item.id));
  assert.equal(ids.length, 1);
  assert.deepEqual(page.items[0].mail_protocols, ["graph"]);
});

test("code filtered selection uses status, search, and quantity filters", () => {
  const type = db.ensureDefaultRedeemEmailType();
  const [matching] = db.createRedeemCodes({
    type_id: type.id,
    count: 1,
    quantity: 3,
    note: "matching",
  });
  db.createRedeemCodes({ type_id: type.id, count: 1, quantity: 1 });
  const [disabled] = db.createRedeemCodes({
    type_id: type.id,
    count: 1,
    quantity: 3,
  });
  db.updateRedeemCodeStatus(disabled.id, "disabled");

  const filters = {
    type_id: type.id,
    status: "unused",
    q: matching.code.slice(0, 4),
    min_quantity: 2,
    max_quantity: 3,
  };
  const page = db.getRedeemCodesPaged(filters);
  const ids = db.getRedeemCodeIds(filters);

  assert.deepEqual(ids, [matching.id]);
  assert.deepEqual(ids, page.items.map((item) => item.id));
});

test("selected item readers support more IDs than a single SQL parameter batch", () => {
  const type = db.ensureDefaultRedeemEmailType();
  const created = db.createRedeemCodes({
    type_id: type.id,
    count: 520,
    quantity: 1,
  });

  const selected = db.getRedeemCodesByIds(created.map((item) => item.id));

  assert.equal(selected.length, 520);
  assert.deepEqual(
    selected.map((item) => item.id),
    created.map((item) => item.id).sort((left, right) => left - right),
  );
});
