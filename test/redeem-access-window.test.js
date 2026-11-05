import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dbPath = path.join(
  os.tmpdir(),
  `redeem-access-window-${process.pid}-${Date.now()}.db`,
);

// 默认（不设置 REDEEM_ACCESS_TTL_MS）就是「不限期」。
delete process.env.REDEEM_ACCESS_TTL_MS;
process.env.DB_PATH = dbPath;

const db = await import("../src/db.js");

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

test("access is unlimited by default", () => {
  assert.equal(db.isRedeemAccessUnlimited(), true);
  assert.equal(db.getRedeemAccessExpiresAt("2026-08-24 10:30:00"), null);
  assert.equal(db.getRedeemAccessTtlHours(), null);
});

test("an ancient redemption stays accessible without a TTL", () => {
  // 2020 年的记录在默认配置下也必须仍然可查。
  assert.equal(db.isRedeemAccessExpired("2020-01-01 00:00:00"), false);
  assert.equal(
    db.isRedeemAccessExpired("2020-01-01T00:00:00.000Z", Date.now()),
    false,
  );
});

test("unusable redemption timestamps are never treated as expired", () => {
  for (const value of ["", null, undefined, "not-a-date"]) {
    assert.equal(db.getRedeemAccessExpiresAt(value), null);
    assert.equal(db.isRedeemAccessExpired(value), false);
  }
});
