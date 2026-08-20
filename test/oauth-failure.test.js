import assert from "node:assert/strict";
import test from "node:test";
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
