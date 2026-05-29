import { toast } from "sonner"
import { ApiError } from "@/lib/api"

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
  if (!value) {
    return "未记录"
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }

  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
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
