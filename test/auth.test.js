import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let tempDir = "";

test.before(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "outlook-manager-auth-test-"));
});

test.after(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("refreshAccessToken caches, deduplicates in-flight refreshes, and honors force refresh", async () => {
  process.env.DB_PATH = path.join(tempDir, `auth-cache-${Date.now()}.db`);
  const authModuleUrl = pathToFileURL(
    path.resolve("src/auth.js")
  ).href;
  const auth = await import(`${authModuleUrl}?cacheBust=${Date.now()}`);

  const originalFetch = global.fetch;
  let callCount = 0;

  global.fetch = async () => {
    callCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 25));

    return new Response(
      JSON.stringify({
        access_token: `access-token-${callCount}`,
        refresh_token: "refresh-token-rotated",
        expires_in: 3600
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );
  };

  try {
    const [first, second] = await Promise.all([
      auth.refreshAccessToken("refresh-token-original", "client-a"),
      auth.refreshAccessToken("refresh-token-original", "client-a")
    ]);

    assert.equal(callCount, 1);
    assert.equal(first.access_token, "access-token-1");
    assert.equal(second.access_token, "access-token-1");
    assert.equal(first.cached, false);
    assert.equal(second.cached, false);

    const cached = await auth.refreshAccessToken(
      "refresh-token-original",
      "client-a"
    );
    assert.equal(callCount, 1);
    assert.equal(cached.cached, true);
    assert.equal(cached.refresh_token, "refresh-token-rotated");

    const rotatedKeyCached = await auth.refreshAccessToken(
      "refresh-token-rotated",
      "client-a"
    );
    assert.equal(callCount, 1);
    assert.equal(rotatedKeyCached.cached, true);

    const forced = await auth.refreshAccessToken(
      "refresh-token-original",
      "client-a",
      { force: true }
    );
    assert.equal(callCount, 2);
    assert.equal(forced.cached, false);
  } finally {
    global.fetch = originalFetch;
  }
});
