export function classifyOauthFailure(payload, bodyText, status) {
  const description = String(
    payload?.error_description || payload?.error || bodyText || `HTTP ${status}`
  ).trim();
  const codeFromPayload = Array.isArray(payload?.error_codes)
    ? payload.error_codes.find((value) => Number.isFinite(Number(value)))
    : "";
  const codeMatch =
    description.match(/AADSTS\d+/i) || description.match(/AADS\d+/i);
  const errorCode =
    codeMatch?.[0]?.toUpperCase() ||
    (codeFromPayload
      ? `AADSTS${codeFromPayload}`
      : String(payload?.error || "OAUTH_ERROR"));
  const expired =
    /\bexpired\b|expiration|已过期|已经过期|已失效/i.test(description) ||
    ["AADSTS700082", "AADSTS700084"].includes(errorCode);

  return {
    outcome: expired ? "expired" : "error",
    error_code: errorCode,
    error_message: description
  };
}
