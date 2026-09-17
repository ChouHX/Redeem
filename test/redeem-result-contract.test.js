import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dbPath = path.join(
  os.tmpdir(),
  `redeem-result-contract-${process.pid}-${Date.now()}.db`,
);
const port = 5800 + (process.pid % 100);

process.env.DB_PATH = dbPath;
process.env.NODE_BACKEND_PORT = String(port);
process.env.NODE_BACKEND_HOST = "127.0.0.1";

const db = await import("../src/db.js");
const { parseInventoryImportText } = await import("../src/redeem.js");
await import("../src/server.js");

const BASE = `http://127.0.0.1:${port}`;

after(() => {
  db.closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(`${dbPath}${suffix}`);
    } catch {
      // Temporary test database files may not all exist on every platform.
    }
  }
  process.exit(0);
});

async function post(pathname, body) {
  const response = await fetch(`${BASE}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await fetch(`${BASE}/api/redeem/catalog`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("测试服务未在预期时间内就绪");
}

function createType(slug, protocols) {
  const base = db.ensureDefaultRedeemEmailType();
  const existing = db
    .getRedeemEmailTypes()
    .find((item) => item.slug === slug);
  if (existing) {
    db.updateRedeemEmailType(existing.id, {
      ...existing,
      mail_protocols: protocols,
    });
    return db.getRedeemEmailTypeById(existing.id);
  }
  return db.createRedeemEmailType({
    slug,
    name: slug,
    description: "",
    field_schema: base.field_schema,
    mail_protocol: protocols[0],
    mail_protocols: protocols,
    import_delimiter: base.import_delimiter,
    is_active: true,
  });
}

// 造一个「账号具备完整 OAuth 凭据、但入库元数据被窄化为 imap」的库存，
// 这正是历史默认协议回填留下的数据形态。
function seedNarrowedAccount(type, line) {
  const parsed = parseInventoryImportText({
    text: line,
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
  return code.code;
}

await waitForServer();

test("exchange reports the account protocols, not the type defaults", async () => {
  const type = createType("contract-dual", ["imap", "graph"]);
  const code = seedNarrowedAccount(
    type,
    "contract-dual@example.com----pass----client----refresh",
  );

  const first = await post("/api/redeem/exchange", { code });
  assert.equal(first.status, 200);
  const data = first.body.data;

  assert.deepEqual(data.mail_protocols, ["imap", "graph"]);
  assert.deepEqual(data.items[0].mail_protocols, ["imap", "graph"]);
  // 类型视图保留允许范围语义，不与账号协议混用。
  assert.deepEqual(data.type.mail_protocols, ["imap", "graph"]);

  // 已兑换后再次兑换走幂等路径，协议不允许退化成类型默认协议。
  const second = await post("/api/redeem/exchange", { code });
  assert.equal(second.status, 200);
  assert.deepEqual(second.body.data.mail_protocols, ["imap", "graph"]);
  assert.deepEqual(second.body.data.items[0].mail_protocols, [
    "imap",
    "graph",
  ]);

  const queried = await post("/api/redeem/query", { code });
  assert.deepEqual(queried.body.data.mail_protocols, ["imap", "graph"]);
  assert.deepEqual(queried.body.data.items[0].mail_protocols, [
    "imap",
    "graph",
  ]);

  const accessed = await post("/api/redeem/access", { code, page_size: 10 });
  assert.deepEqual(accessed.body.data.mail_protocols, ["imap", "graph"]);
  assert.deepEqual(accessed.body.data.items[0].mail_protocols, [
    "imap",
    "graph",
  ]);
});

test("the type protocol range still caps what an account can use", async () => {
  const type = createType("contract-imap-only", ["imap"]);
  const code = seedNarrowedAccount(
    type,
    "contract-imap-only@example.com----pass----client----refresh",
  );

  const exchanged = await post("/api/redeem/exchange", { code });
  assert.deepEqual(exchanged.body.data.mail_protocols, ["imap"]);
  assert.deepEqual(exchanged.body.data.items[0].mail_protocols, ["imap"]);
  assert.deepEqual(exchanged.body.data.type.mail_protocols, ["imap"]);
});

test("an account without OAuth credentials keeps its stored protocol", async () => {
  const type = createType("contract-plain", ["imap", "graph"]);
  const parsed = parseInventoryImportText({
    text: "plain@example.com----pass",
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

  // 没有 OAuth 凭据时不推断账号能力，只沿用入库元数据，避免凭空放大协议。
  const exchanged = await post("/api/redeem/exchange", { code: code.code });
  assert.deepEqual(exchanged.body.data.items[0].mail_protocols, ["graph"]);
});

test("result payload stays lean without duplicated type copies", async () => {
  const type = createType("contract-lean", ["imap", "graph"]);
  const code = seedNarrowedAccount(
    type,
    "contract-lean@example.com----pass----client----refresh",
  );

  const { body } = await post("/api/redeem/exchange", { code });
  const data = body.data;

  assert.deepEqual(Object.keys(data.items[0]).sort(), [
    "formatted_line",
    "mail_protocols",
    "payload",
  ]);
  for (const redundant of ["fields", "payload", "formatted_line", "type"]) {
    assert.equal(redundant in data, false, `${redundant} should not be on root`);
  }
  assert.equal(data.items[0].formatted_line, data.items[0].payload.raw_line);
});
