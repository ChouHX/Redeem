import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { classifyOauthFailure } from "../src/token-check.js";

test("OAuth failures distinguish expired tokens from AADSTS errors", () => {
  const expired = classifyOauthFailure(
    {
      error: "invalid_grant",
      error_codes: [700082],
      error_description:
        "AADSTS700082: The refresh token has expired due to inactivity."
    },
    "",
    400
  );
  const error = classifyOauthFailure(
    {
      error: "unauthorized_client",
      error_codes: [700016],
      error_description: "AADSTS700016: Application was not found."
    },
    "",
    400
  );

  assert.equal(expired.outcome, "expired");
  assert.equal(expired.error_code, "AADSTS700082");
  assert.equal(error.outcome, "error");
  assert.equal(error.error_code, "AADSTS700016");
});

test("token checks run in a worker thread and report malformed inventory", async () => {
  const worker = new Worker(
    new URL("../src/token-check-worker.js", import.meta.url),
    {
      workerData: {
        candidates: [
          {
            inventory_id: 1,
            serialized_value: "malformed-line",
            protocol: "imap",
            credentials: null
          }
        ],
        token_url: "",
        imap_scope: "imap-scope",
        graph_scope: "graph-scope",
        concurrency: 1,
        timeout_ms: 1000
      }
    }
  );
  const results = [];

  await new Promise((resolve, reject) => {
    let completed = false;
    worker.on("message", (message) => {
      if (message.type === "result") {
        results.push(message.result);
      } else if (message.type === "done") {
        completed = true;
      } else if (message.type === "fatal") {
        reject(new Error(message.message));
      }
    });
    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (completed && code === 0) {
        resolve();
      } else {
        reject(new Error(`worker exited before completion (${code})`));
      }
    });
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].outcome, "error");
  assert.equal(results[0].error_code, "PARSE_ERROR");
});
