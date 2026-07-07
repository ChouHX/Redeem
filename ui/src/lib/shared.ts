import { toast } from "sonner"
import { ApiError } from "@/lib/api"

const CHINA_TIME_ZONE = "Asia/Shanghai"
const SQLITE_UTC_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/
const DATETIME_LOCAL_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/

type DateTimeParts = {
  year: string
  month: string
  day: string
  hour: string
  minute: string
  second: string
}

const chinaDateTimePartsFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: CHINA_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
})

function getChinaDateTimeParts(date: Date): DateTimeParts {
  const values: Partial<DateTimeParts> = {}

  for (const part of chinaDateTimePartsFormatter.formatToParts(date)) {
    switch (part.type) {
      case "year":
      case "month":
      case "day":
      case "hour":
      case "minute":
      case "second":
        values[part.type] = part.value
        break
    }
  }

  return {
    year: values.year ?? "0000",
    month: values.month ?? "00",
    day: values.day ?? "00",
    hour: values.hour ?? "00",
    minute: values.minute ?? "00",
    second: values.second ?? "00",
  }
}

function dateFromChinaLocalMatch(match: RegExpExecArray) {
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6] ?? 0)
  const date = new Date(Date.UTC(year, month - 1, day, hour - 8, minute, second))
  const parts = getChinaDateTimeParts(date)

  if (
    parts.year !== match[1] ||
    parts.month !== match[2] ||
    parts.day !== match[3] ||
    parts.hour !== match[4] ||
    parts.minute !== match[5]
  ) {
    return null
  }

  return date
}

function parseDateTime(value: string | null | undefined) {
  const trimmed = String(value || "").trim()
  if (!trimmed) {
    return null
  }

  // SQLite CURRENT_TIMESTAMP is UTC but has no timezone suffix.
  const normalizedValue = SQLITE_UTC_TIMESTAMP_PATTERN.test(trimmed)
    ? `${trimmed.replace(" ", "T")}Z`
    : trimmed
  const localMatch = DATETIME_LOCAL_PATTERN.exec(normalizedValue)
  const date = localMatch
    ? dateFromChinaLocalMatch(localMatch)
    : new Date(normalizedValue)

  if (!date || Number.isNaN(date.getTime())) {
    return null
  }

  return date
}

export function formatErrorMessage(error: unknown) {
  if (error instanceof ApiError) {
    return error.message
  }

  if (error instanceof Error) {
    return error.message
  }

  return "请求失败，请稍后重试"
}

export function formatDateTime(value: string | null | undefined) {
  const date = parseDateTime(value)
  if (!date) {
    return value || "未记录"
  }

  const parts = getChinaDateTimeParts(date)
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`
}

export function formatChinaDatetimeLocalValue(value: string | null | undefined) {
  const trimmed = String(value || "").trim()
  if (!trimmed) {
    return ""
  }

  if (DATETIME_LOCAL_PATTERN.test(trimmed)) {
    return trimmed.slice(0, 16)
  }

  const date = parseDateTime(trimmed)
  if (!date) {
    return ""
  }

  const parts = getChinaDateTimeParts(date)
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`
}

export function chinaDatetimeLocalToIso(value: string) {
  const trimmed = value.trim()
  if (!trimmed) {
    return undefined
  }

  const localMatch = DATETIME_LOCAL_PATTERN.exec(trimmed)
  const date = localMatch ? dateFromChinaLocalMatch(localMatch) : parseDateTime(trimmed)
  if (!date) {
    throw new Error("时间格式不正确")
  }

  return date.toISOString()
}

export function notify(
  title: string,
  description: string,
  variant: "default" | "destructive" = "default"
) {
  if (variant === "destructive") {
    toast.error(title, { description })
    return
  }

  toast.success(title, { description })
}

export async function copyTextToClipboard(value: string, label: string) {
  try {
    await navigator.clipboard.writeText(value)
    notify("复制成功", `${label} 已复制到剪贴板`)
  } catch {
    notify("复制失败", "当前浏览器不支持自动复制，请手动复制。", "destructive")
  }
}
