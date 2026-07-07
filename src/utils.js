export function ok(data = null, message = "") {
  return { success: true, data, message };
}

export function fail(message, data = null) {
  return { success: false, data, message };
}

export function normalizeEmail(email) {
  return String(email || "").trim();
}

const CHINA_TIME_ZONE = "Asia/Shanghai";
const chinaDateTimePartsFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: CHINA_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23"
});

function getChinaDateTimeParts(date) {
  const values = {};

  for (const part of chinaDateTimePartsFormatter.formatToParts(date)) {
    values[part.type] = part.value;
  }

  return {
    year: values.year || "0000",
    month: values.month || "00",
    day: values.day || "00",
    hour: values.hour || "00",
    minute: values.minute || "00",
    second: values.second || "00"
  };
}

export function formatDateTime(date = new Date()) {
  const { year, month, day, hour, minute, second } = getChinaDateTimeParts(date);
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}
