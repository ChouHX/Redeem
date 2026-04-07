export function ok(data = null, message = "") {
  return { success: true, data, message };
}

export function fail(message, data = null) {
  return { success: false, data, message };
}

export function normalizeEmail(email) {
  return String(email || "").trim();
}

export function formatDateTime(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}
