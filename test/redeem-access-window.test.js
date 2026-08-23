import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dbPath = path.join(
  os.tmpdir(),
  `redeem-access-window-${process.pid}-${Date.now()}.db`,
);

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

test("access expiry is 24h after the SQLite UTC redemption timestamp", () => {
  assert.equal(
    db.getRedeemAccessExpiresAt("2026-08-24 10:30:00"),
    "2026-08-25T10:30:00.000Z",
  );
  assert.equal(
    db.getRedeemAccessExpiresAt("2026-08-24T10:30:00.000Z"),
    "2026-08-25T10:30:00.000Z",
  );
  assert.equal(db.getRedeemAccessTtlHours(), 24);
});

test("access expiry is null when the redemption timestamp is unusable", () => {
  for (const value of ["", null, undefined, "not-a-date"]) {
    assert.equal(db.getRedeemAccessExpiresAt(value), null);
    assert.equal(db.isRedeemAccessExpired(value), false);
  }
});

test("expiry boundary matches isRedeemAccessExpired", () => {
  const redeemedAt = "2026-08-24 10:30:00";
  const expiresAt = Date.parse(db.getRedeemAccessExpiresAt(redeemedAt));

  assert.equal(db.isRedeemAccessExpired(redeemedAt, expiresAt - 1), false);
  assert.equal(db.isRedeemAccessExpired(redeemedAt, expiresAt), true);
});
