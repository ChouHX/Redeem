import { useEffect, useState } from "react"
import {
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  GripVerticalIcon,
  InfoIcon,
  MailIcon,
  MegaphoneIcon,
  PlusIcon,
  RefreshCcwIcon,
  SearchIcon,
  ShieldCheckIcon,
  SparklesIcon,
  TicketIcon,
  Trash2Icon,
  WrenchIcon,
} from "lucide-react"

import {
  type AdSlotConfig,
  ApiError,
  type FaqConfig,
  type GeminiProTaskItem,
  type GeminiProTasksResult,
  type RedeemCatalog,
  type RedeemExchangeResult,
  type RedeemOrderQueryResult,
  exchangeRedeemCode,
  fetchGeminiProTasks,
  fetchPublicAds,
  fetchPublicFaq,
  fetchRedeemCatalog,
  queryRedeemOrder,
  submitGeminiProTasks,
} from "@/lib/api"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { AdSlotCard } from "@/components/ad-slot-card"
import { RichTextContent } from "@/components/rich-text-content"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Field, FieldContent, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ThemeToggle } from "@/components/theme-toggle"
import { Textarea } from "@/components/ui/textarea"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { createTextExportFilename, downloadTextFile } from "@/lib/utils"
import { toast } from "sonner"

type ResultLineItem = {
  formatted_line: string
}

type ToolFieldConfig = {
  key: string
  label: string
  index: number
  enabled: boolean
}

const MAX_VISIBLE_RESULT_ITEMS = 10
const TOOL_DEFAULT_SOURCE_DELIMITER = "----"
const TOOL_DEFAULT_OUTPUT_DELIMITER = "----"

function formatErrorMessage(error: unknown) {
  if (error instanceof ApiError) {
    return error.message
  }

  if (error instanceof Error) {
    return error.message
  }

  return "请求失败，请稍后重试"
}

function formatDateTime(value: string | null | undefined) {
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

function buildResultText(items: ResultLineItem[]) {
  return items.map((item) => item.formatted_line).join("\n")
}

function splitToolLine(line: string, delimiter: string) {
  return line.split(delimiter).map((item) => item.trim())
}

async function copyTextToClipboard(
  value: string,
  label: string
) {
  try {
    await navigator.clipboard.writeText(value)
    toast.success("复制成功", {
      description: `${label} 已复制到剪贴板`,
    })
  } catch {
    toast.error("复制失败", {
      description: "当前浏览器不支持自动复制，请手动复制。",
    })
  }
}

function notify(
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

const GEMINIPRO_STATUS_MAP: Record<
  number,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  1: { label: "等待", variant: "outline" },
  2: { label: "处理中", variant: "secondary" },
  3: { label: "完成", variant: "default" },
  4: { label: "失败", variant: "destructive" },
  5: { label: "已取消", variant: "outline" },
}

function GeminiProStatusBadge({ task }: { task: GeminiProTaskItem }) {
  const fallback = GEMINIPRO_STATUS_MAP[task.status]
  const label = task.status_desc || fallback?.label || `状态 ${task.status}`
  const variant = fallback?.variant || "outline"
  return <Badge variant={variant}>{label}</Badge>
}

function ResultOutputCard({
  badgeLabel,
  title,
  description,
  code,
  typeName,
  itemCount,
  redeemedAt,
  items,
  downloadPrefix,
}: {
  badgeLabel: string
  title: string
  description: string
  code: string
  typeName: string
  itemCount: number
  redeemedAt: string
  items: ResultLineItem[]
  downloadPrefix: string
}) {
  const visibleItems = items.slice(0, MAX_VISIBLE_RESULT_ITEMS)
  const hiddenItemCount = Math.max(0, items.length - MAX_VISIBLE_RESULT_ITEMS)
  const visibleText = buildResultText(visibleItems)
  const fullText = buildResultText(items)

  function handleDownload() {
    downloadTextFile(fullText, createTextExportFilename(downloadPrefix, code))
    notify("下载成功", `已下载 ${itemCount} 条结果内容。`)
  }

  return (
    <Card className="border border-border/70 bg-card/92 backdrop-blur">
      <CardHeader className="border-b border-border/70">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>{badgeLabel}</Badge>
          <Badge variant="outline">{typeName}</Badge>
          <Badge variant="outline">数量 {itemCount}</Badge>
          <Badge variant="secondary">{formatDateTime(redeemedAt)}</Badge>
        </div>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void copyTextToClipboard(code, "兑换码")}
          >
            <CopyIcon data-icon="inline-start" />
            复制卡密
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void copyTextToClipboard(fullText, "结果内容")}
          >
            <CopyIcon data-icon="inline-start" />
            复制结果
          </Button>
          <Button variant="outline" size="sm" onClick={handleDownload}>
            <DownloadIcon data-icon="inline-start" />
            下载 TXT
          </Button>
        </div>

        {hiddenItemCount > 0 ? (
          <Alert>
            <SearchIcon />
            <AlertTitle>仅展示前 10 条</AlertTitle>
            <AlertDescription>
              当前结果共 {itemCount} 条，剩余 {hiddenItemCount} 条已隐藏，请使用下载按钮查看完整内容。
            </AlertDescription>
          </Alert>
        ) : null}

        <Textarea
          value={visibleText}
          readOnly
          rows={Math.max(6, Math.min(MAX_VISIBLE_RESULT_ITEMS + 1, visibleItems.length + 1))}
          wrap="off"
          spellCheck={false}
          className="min-h-64 resize-y overflow-x-scroll overflow-y-auto font-mono text-xs leading-6"
        />
      </CardContent>
    </Card>
  )
}

export function RedeemConsole() {
  const [catalog, setCatalog] = useState<RedeemCatalog["types"]>([])
  const [adSlot, setAdSlot] = useState<AdSlotConfig | null>(null)
  const [faq, setFaq] = useState<FaqConfig | null>(null)
  const [activeTab, setActiveTab] = useState("exchange")
  const [exchangeResult, setExchangeResult] = useState<RedeemExchangeResult | null>(null)
  const [exchangeCode, setExchangeCode] = useState("")
  const [queryCode, setQueryCode] = useState("")
  const [queryResult, setQueryResult] = useState<RedeemOrderQueryResult | null>(null)
  const [toolCode, setToolCode] = useState("")
  const [toolInput, setToolInput] = useState("")
  const [toolSourceDelimiter, setToolSourceDelimiter] = useState(
    TOOL_DEFAULT_SOURCE_DELIMITER
  )
  const [toolOutputDelimiter, setToolOutputDelimiter] = useState(
    TOOL_DEFAULT_OUTPUT_DELIMITER
  )
  const [toolFields, setToolFields] = useState<ToolFieldConfig[]>([])
  const [draggedToolFieldKey, setDraggedToolFieldKey] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [exchangeSubmitting, setExchangeSubmitting] = useState(false)
  const [querySubmitting, setQuerySubmitting] = useState(false)
  const [toolCodeSubmitting, setToolCodeSubmitting] = useState(false)

  const [geminiProCode, setGeminiProCode] = useState("")
  const [geminiProSubmitting, setGeminiProSubmitting] = useState(false)
  const [geminiProResult, setGeminiProResult] =
    useState<GeminiProTasksResult | null>(null)
  const GEMINIPRO_PAGE_SIZE = 20

  type GeminiProAccountRow = {
    key: string
    account: string
    password: string
    totp: string
  }
  function createGeminiProAccountRow(): GeminiProAccountRow {
    return {
      key: `gp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      account: "",
      password: "",
      totp: "",
    }
  }
  const [geminiProAccounts, setGeminiProAccounts] = useState<
    GeminiProAccountRow[]
  >(() => [createGeminiProAccountRow()])
  const [geminiProTaskSubmitting, setGeminiProTaskSubmitting] = useState(false)
  const [geminiProSubmitDialogOpen, setGeminiProSubmitDialogOpen] =
    useState(false)
  const [geminiProNoticesOpen, setGeminiProNoticesOpen] = useState(false)
  const [geminiProNoticesSeen, setGeminiProNoticesSeen] = useState(false)

  const normalizedToolInputLines = toolInput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const expectedToolSegmentCount = normalizedToolInputLines[0]
    ? splitToolLine(
        normalizedToolInputLines[0],
        toolSourceDelimiter || TOOL_DEFAULT_SOURCE_DELIMITER
      ).length
    : 0
  const selectedToolFields = toolFields.filter((field) => field.enabled)
  const toolOutputText = normalizedToolInputLines
    .map((line) => {
      const parts = splitToolLine(
        line,
        toolSourceDelimiter || TOOL_DEFAULT_SOURCE_DELIMITER
      )
      return selectedToolFields
        .map((field) => parts[field.index] || "")
        .join(toolOutputDelimiter || TOOL_DEFAULT_OUTPUT_DELIMITER)
    })
    .join("\n")
  const invalidToolLineCount = normalizedToolInputLines.filter((line) => {
    const delimiter = toolSourceDelimiter || TOOL_DEFAULT_SOURCE_DELIMITER
    return line.split(delimiter).length < Math.max(expectedToolSegmentCount, 1)
  }).length

  useEffect(() => {
    if (!expectedToolSegmentCount) {
      setToolFields([])
      return
    }

    setToolFields((current) => {
      const currentMap = new Map(current.map((field) => [field.index, field]))
      const keptIndexes = current
        .map((field) => field.index)
        .filter((index) => index < expectedToolSegmentCount)
      const missingIndexes = Array.from(
        { length: expectedToolSegmentCount },
        (_, index) => index
      ).filter((index) => !keptIndexes.includes(index))

      return [...keptIndexes, ...missingIndexes].map((index) => {
        const existing = currentMap.get(index)
        return {
          key: `segment_${index}`,
          index,
          label: `第 ${index + 1} 段`,
          enabled: existing ? existing.enabled : index < 2,
        }
      })
    })
  }, [expectedToolSegmentCount])

  async function loadCatalog() {
    setLoading(true)
    try {
      const nextCatalog = await fetchRedeemCatalog()
      setCatalog(nextCatalog.types)
    } catch (error) {
      notify("加载失败", formatErrorMessage(error), "destructive")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadCatalog()
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        setAdSlot(await fetchPublicAds())
      } catch {
        setAdSlot(null)
      }
    })()
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        setFaq(await fetchPublicFaq())
      } catch {
        setFaq(null)
      }
    })()
  }, [])

  useEffect(() => {
    if (activeTab === "geminipro" && !geminiProNoticesSeen) {
      setGeminiProNoticesOpen(true)
      setGeminiProNoticesSeen(true)
    }
  }, [activeTab, geminiProNoticesSeen])

  async function handleExchange(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextCode = exchangeCode.trim()
    if (!nextCode) {
      notify("请输入兑换码", "卡密不能为空。", "destructive")
      return
    }

    setExchangeSubmitting(true)

    try {
      const payload = await exchangeRedeemCode(nextCode)
      setExchangeResult(payload.data)
      setExchangeCode("")
      setQueryCode(payload.data.code)
      notify("兑换成功", "邮箱数据已发放，请尽快复制保存。")
      await loadCatalog()
    } catch (error) {
      setExchangeResult(null)
      notify("兑换失败", formatErrorMessage(error), "destructive")
    } finally {
      setExchangeSubmitting(false)
    }
  }

  async function handleQuery(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextCode = queryCode.trim()
    if (!nextCode) {
      notify("请输入兑换码", "订单查询需要兑换码。", "destructive")
      return
    }

    setQuerySubmitting(true)

    try {
      const payload = await queryRedeemOrder(nextCode)
      setQueryResult(payload)
      notify("查询成功", "已载入该兑换码对应的已兑换订单。")
    } catch (error) {
      setQueryResult(null)
      notify("查询失败", formatErrorMessage(error), "destructive")
    } finally {
      setQuerySubmitting(false)
    }
  }

  function moveToolFieldToTarget(sourceKey: string, targetKey: string) {
    if (sourceKey === targetKey) {
      return
    }

    setToolFields((current) => {
      const sourceIndex = current.findIndex((field) => field.key === sourceKey)
      const targetIndex = current.findIndex((field) => field.key === targetKey)
      if (sourceIndex < 0 || targetIndex < 0) {
        return current
      }

      const nextFields = [...current]
      const [sourceField] = nextFields.splice(sourceIndex, 1)
      nextFields.splice(targetIndex, 0, sourceField)
      return nextFields
    })
  }

  function toggleToolField(key: string, enabled: boolean) {
    setToolFields((current) =>
      current.map((field) =>
        field.key === key ? { ...field, enabled } : field
      )
    )
  }

  function applyToolPreset(mode: "first_two" | "all") {
    setToolFields((current) =>
      current.map((field, index) => ({
        ...field,
        enabled: mode === "all" ? true : index < 2,
      }))
    )
  }

  function resetTool() {
    setToolCode("")
    setToolInput("")
    setToolSourceDelimiter(TOOL_DEFAULT_SOURCE_DELIMITER)
    setToolOutputDelimiter(TOOL_DEFAULT_OUTPUT_DELIMITER)
    setToolFields([])
    setDraggedToolFieldKey(null)
  }

  async function importToolSourceByCode() {
    const nextCode = toolCode.trim()
    if (!nextCode) {
      notify("请输入兑换码", "导入原始数据前需要先输入兑换码。", "destructive")
      return
    }

    setToolCodeSubmitting(true)

    try {
      try {
        const queried = await queryRedeemOrder(nextCode)
        const importedText = queried.items.map((item) => item.formatted_line).join("\n")
        setToolInput(importedText)
        notify("导入成功", `已从已兑换订单导入 ${queried.item_count} 条原始数据。`)
        return
      } catch (queryError) {
        const queryMessage = formatErrorMessage(queryError)
        const shouldExchange =
          queryMessage.includes("尚未兑换") ||
          queryMessage.includes("暂无订单可查询")

        if (!shouldExchange) {
          notify("导入失败", queryMessage, "destructive")
          return
        }
      }

      const exchanged = await exchangeRedeemCode(nextCode)
      const importedText = exchanged.data.items
        .map((item) => item.formatted_line)
        .join("\n")
      setToolInput(importedText)
      setQueryCode(exchanged.data.code)
      notify(
        "兑换并导入成功",
        `已自动兑换并导入 ${exchanged.data.redeemed_count} 条原始数据。`
      )
    } catch (exchangeError) {
      notify("导入失败", formatErrorMessage(exchangeError), "destructive")
    } finally {
      setToolCodeSubmitting(false)
    }
  }

  function handleToolDownload() {
    if (!toolOutputText.trim()) {
      notify("没有可导出内容", "请先输入原始数据并选择要输出的字段。", "destructive")
      return
    }

    downloadTextFile(
      toolOutputText,
      createTextExportFilename("redeem_extract", "fields")
    )
    notify("导出成功", `已导出 ${normalizedToolInputLines.length} 行提取结果。`)
  }

  async function loadGeminiProTasks(code: string, page: number) {
    const trimmed = code.trim()
    if (!trimmed) {
      notify("请输入卡密", "卡密不能为空。", "destructive")
      return
    }

    setGeminiProSubmitting(true)
    try {
      const data = await fetchGeminiProTasks(trimmed, {
        page,
        page_size: GEMINIPRO_PAGE_SIZE,
      })
      setGeminiProResult(data)
      notify("查询成功", `共 ${data.total} 条任务记录。`)
    } catch (error) {
      setGeminiProResult(null)
      notify("查询失败", formatErrorMessage(error), "destructive")
    } finally {
      setGeminiProSubmitting(false)
    }
  }

  async function handleGeminiProSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await loadGeminiProTasks(geminiProCode, 1)
  }

  async function handleGeminiProPageChange(nextPage: number) {
    await loadGeminiProTasks(geminiProCode, nextPage)
  }

  function updateGeminiProAccount(
    key: string,
    field: keyof Omit<GeminiProAccountRow, "key">,
    value: string
  ) {
    setGeminiProAccounts((current) =>
      current.map((row) =>
        row.key === key ? { ...row, [field]: value } : row
      )
    )
  }

  function addGeminiProAccountRow() {
    setGeminiProAccounts((current) => [...current, createGeminiProAccountRow()])
  }

  function removeGeminiProAccountRow(key: string) {
    setGeminiProAccounts((current) => {
      if (current.length <= 1) {
        return [createGeminiProAccountRow()]
      }
      return current.filter((row) => row.key !== key)
    })
  }

  async function handleGeminiProTaskSubmit(
    event: React.FormEvent<HTMLFormElement>
  ) {
    event.preventDefault()
    const card = geminiProCode.trim()
    if (!card) {
      notify("请输入卡密", "卡密不能为空。", "destructive")
      return
    }

    const accountLines: string[] = []
    for (const [index, row] of geminiProAccounts.entries()) {
      const account = row.account.trim()
      const password = row.password.trim()
      const totp = row.totp.trim().replace(/\s+/g, "")

      if (!account && !password && !totp) {
        continue
      }

      if (!account || !password || !totp) {
        notify(
          `第 ${index + 1} 行不完整`,
          "账号、密码、2FA 密钥均为必填项。",
          "destructive"
        )
        return
      }

      if (!/^[A-Za-z0-9]{32}$/.test(totp)) {
        notify(
          `第 ${index + 1} 行 2FA 密钥格式不对`,
          "2FA 密钥需为 32 位字母或数字组合。",
          "destructive"
        )
        return
      }

      accountLines.push(`${account}--${password}--${totp}`)
    }

    if (!accountLines.length) {
      notify("请至少填写一组账号", "账号列表为空。", "destructive")
      return
    }

    setGeminiProTaskSubmitting(true)
    try {
      const payload = await submitGeminiProTasks({
        card,
        accounts: accountLines,
      })
      notify(
        "提交成功",
        payload.message || `已提交 ${accountLines.length} 条账号。`
      )
      setGeminiProSubmitDialogOpen(false)
      setGeminiProAccounts([createGeminiProAccountRow()])
      await loadGeminiProTasks(card, 1)
    } catch (error) {
      notify("提交失败", formatErrorMessage(error), "destructive")
    } finally {
      setGeminiProTaskSubmitting(false)
    }
  }

  function openGeminiProSubmitDialog() {
    if (!geminiProCode.trim()) {
      notify("请先输入卡密", "先在上方输入卡密再提交任务。", "destructive")
      return
    }
    setGeminiProSubmitDialogOpen(true)
  }

  return (
    <main className="page-shell page-shell-redeem relative min-h-svh overflow-hidden">
      <div className="redeem-noise pointer-events-none absolute inset-0 opacity-70" />
      <div className="relative mx-auto flex min-h-svh w-full max-w-6xl flex-col gap-6 px-4 py-6 md:px-6 lg:px-8">
        <header className="border-b border-border/70 pb-5">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="flex flex-col gap-2">
              <h1 className="font-heading text-3xl font-medium tracking-tight md:text-4xl">
                Redeem
              </h1>
              <p className="text-sm text-muted-foreground">
                输入卡密，立即领取可用邮箱数据。
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <ThemeToggle />
              <Button variant="outline" size="sm" asChild>
                <a href="/mail">
                  <MailIcon data-icon="inline-start" />
                  查看邮件
                </a>
              </Button>
            </div>
          </div>
        </header>

        {adSlot?.enabled ? (
          <div className="mx-auto w-full max-w-4xl">
            <AdSlotCard
              title={adSlot.title}
              description={adSlot.description}
              imageUrl={adSlot.image_url}
              primaryAction={
                adSlot.primary_action.href
                  ? {
                      label: adSlot.primary_action.label,
                      href: adSlot.primary_action.href,
                    }
                  : undefined
              }
            />
          </div>
        ) : null}

        <section className="mx-auto flex w-full max-w-4xl flex-col gap-5">
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <div className="overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <TabsList variant="line" className="min-w-max">
                <TabsTrigger value="exchange">
                  <TicketIcon />
                  兑换
                </TabsTrigger>
                <TabsTrigger value="orders">
                  <SearchIcon />
                  订单查询
                </TabsTrigger>
                <TabsTrigger value="tools">
                  <WrenchIcon />
                  字段提取
                </TabsTrigger>
                <TabsTrigger value="geminipro">
                  <SparklesIcon />
                  GeminiPro
                </TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="exchange" className="flex flex-col gap-5">
              <Card className="border border-border/70 bg-card/92 backdrop-blur">
              <CardHeader className="border-b border-border/70">
                  <CardAction>
                    <Button variant="ghost" size="icon-sm" onClick={() => void loadCatalog()}>
                      <RefreshCcwIcon />
                      <span className="sr-only">刷新</span>
                    </Button>
                  </CardAction>
                  <CardTitle className="text-xl md:text-2xl">输入兑换码</CardTitle>
                  <CardDescription>支持大小写混输，每个兑换码仅可使用一次。</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-5">
                  <form className="flex flex-col gap-4" onSubmit={handleExchange}>
                    <FieldGroup>
                      <Field>
                        <FieldLabel htmlFor="redeem-code">兑换码</FieldLabel>
                        <FieldContent>
                          <Input
                            id="redeem-code"
                            value={exchangeCode}
                            onChange={(event) => setExchangeCode(event.target.value)}
                            placeholder="例如 MAIL-ABCD-EFGH-JKLM"
                            autoComplete="off"
                            className="h-12 text-base"
                          />
                        </FieldContent>
                      </Field>
                    </FieldGroup>
                    {!loading && catalog.length ? (
                      <div className="flex flex-col gap-2">
                        <p className="text-xs text-muted-foreground">可兑类型</p>
                        <div className="flex flex-wrap gap-2 text-xs text-foreground/80">
                          {catalog.map((type) => (
                            <span
                              key={type.id}
                              className="border border-border/70 px-2 py-1"
                            >
                              {type.name} · 库存 {type.available_inventory_count}
                            </span>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-3">
                      <Button
                        type="submit"
                        size="lg"
                        disabled={exchangeSubmitting}
                        className="min-w-40"
                      >
                        <TicketIcon data-icon="inline-start" />
                        {exchangeSubmitting ? "兑换中..." : "立即兑换"}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="lg"
                        onClick={() => {
                          setExchangeCode("")
                          setExchangeResult(null)
                        }}
                      >
                        清空
                      </Button>
                    </div>
                  </form>
                </CardContent>
              </Card>

              {exchangeResult ? (
                <ResultOutputCard
                  badgeLabel="已发放"
                  title="兑换结果"
                  description="结果按整行格式展示，可直接复制或下载为 TXT。"
                  code={exchangeResult.code}
                  typeName={exchangeResult.type.name}
                  itemCount={exchangeResult.redeemed_count}
                  redeemedAt={exchangeResult.redeemed_at}
                  items={exchangeResult.items}
                  downloadPrefix="redeem_result"
                />
              ) : null}
            </TabsContent>

            <TabsContent value="orders" className="flex flex-col gap-5">
              <Card className="border border-border/70 bg-card/92 backdrop-blur">
                <CardHeader className="border-b border-border/70">
                  <CardTitle className="text-xl md:text-2xl">订单查询</CardTitle>
                  <CardDescription>
                    输入已兑换的兑换码，查看对应订单内容。若超过 10 条，仅展示前 10 条。
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-5">
                  <form className="flex flex-col gap-4" onSubmit={handleQuery}>
                    <FieldGroup>
                      <Field>
                        <FieldLabel htmlFor="redeem-order-code">兑换码</FieldLabel>
                        <FieldContent>
                          <Input
                            id="redeem-order-code"
                            value={queryCode}
                            onChange={(event) => setQueryCode(event.target.value)}
                            placeholder="输入已兑换的兑换码"
                            autoComplete="off"
                            className="h-12 text-base"
                          />
                        </FieldContent>
                      </Field>
                    </FieldGroup>
                    <div className="flex flex-wrap items-center gap-3">
                      <Button
                        type="submit"
                        size="lg"
                        disabled={querySubmitting}
                        className="min-w-40"
                      >
                        <SearchIcon data-icon="inline-start" />
                        {querySubmitting ? "查询中..." : "查询订单"}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="lg"
                        onClick={() => {
                          setQueryCode("")
                          setQueryResult(null)
                        }}
                      >
                        清空
                      </Button>
                    </div>
                  </form>
                </CardContent>
              </Card>

              {queryResult ? (
                <ResultOutputCard
                  badgeLabel="已兑换订单"
                  title="查询结果"
                  description="结果按原始数据直接展示在文本框中，一行一条，可下载当前结果为 TXT。"
                  code={queryResult.code}
                  typeName={queryResult.type.name}
                  itemCount={queryResult.item_count}
                  redeemedAt={queryResult.redeemed_at}
                  items={queryResult.items}
                  downloadPrefix="redeem_order"
                />
              ) : null}
            </TabsContent>

            <TabsContent value="tools" className="flex flex-col gap-5">
              <Card className="border border-border/70 bg-card/92 backdrop-blur">
                <CardHeader className="border-b border-border/70">
                  <CardTitle className="text-xl md:text-2xl">字段提取工具</CardTitle>
                  <CardDescription>
                    纯前端处理，不会把内容提交到服务器。可手动粘贴原始数据，或直接通过兑换码导入；系统会按第一行自动识别段数，再由你自由选择和排序输出字段。
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-5">
                  <FieldGroup>
                    <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto]">
                      <Field>
                        <FieldLabel htmlFor="tool-code">通过兑换码导入</FieldLabel>
                        <FieldContent>
                          <Input
                            id="tool-code"
                            value={toolCode}
                            onChange={(event) => setToolCode(event.target.value)}
                            placeholder="输入兑换码后自动导入原始数据"
                            autoComplete="off"
                          />
                        </FieldContent>
                      </Field>
                      <div className="flex items-end">
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => void importToolSourceByCode()}
                          disabled={toolCodeSubmitting}
                        >
                          <TicketIcon data-icon="inline-start" />
                          {toolCodeSubmitting ? "导入中..." : "导入数据"}
                        </Button>
                      </div>
                    </div>

                    <div className="grid gap-4 md:grid-cols-2">
                      <Field>
                        <FieldLabel htmlFor="tool-source-delimiter">
                          输入分隔符
                        </FieldLabel>
                        <FieldContent>
                          <Input
                            id="tool-source-delimiter"
                            value={toolSourceDelimiter}
                            onChange={(event) =>
                              setToolSourceDelimiter(event.target.value)
                            }
                          />
                        </FieldContent>
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="tool-output-delimiter">
                          输出分隔符
                        </FieldLabel>
                        <FieldContent>
                          <Input
                            id="tool-output-delimiter"
                            value={toolOutputDelimiter}
                            onChange={(event) =>
                              setToolOutputDelimiter(event.target.value)
                            }
                          />
                        </FieldContent>
                      </Field>
                    </div>
                  </FieldGroup>

                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => applyToolPreset("first_two")}
                    >
                      前两段
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => applyToolPreset("all")}
                    >
                      全部段
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={resetTool}
                    >
                      清空
                    </Button>
                  </div>

                  <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                    <FieldGroup>
                      <Field>
                        <FieldLabel htmlFor="tool-input">原始数据</FieldLabel>
                        <FieldContent>
                          <Textarea
                            id="tool-input"
                            value={toolInput}
                            onChange={(event) => setToolInput(event.target.value)}
                            placeholder="每行一条，例如&#10;account@example.com----password----client_id_value----refresh_token_value"
                            wrap="off"
                            spellCheck={false}
                            className="h-80 resize-none overflow-x-auto overflow-y-auto font-mono text-xs leading-6"
                          />
                        </FieldContent>
                      </Field>
                    </FieldGroup>

                    <div className="flex flex-col gap-4">
                      <FieldGroup>
                        <Field>
                          <FieldLabel htmlFor="tool-output">输出结果</FieldLabel>
                          <FieldContent>
                            <Textarea
                              id="tool-output"
                              value={toolOutputText}
                              readOnly
                              wrap="off"
                              spellCheck={false}
                              className="h-80 resize-none overflow-x-auto overflow-y-auto font-mono text-xs leading-6"
                            />
                          </FieldContent>
                        </Field>
                      </FieldGroup>

                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline">
                            输入 {normalizedToolInputLines.length} 行
                          </Badge>
                          <Badge variant="outline">
                            识别 {expectedToolSegmentCount} 段
                          </Badge>
                          <Badge variant="outline">
                            输出 {selectedToolFields.length} 段
                          </Badge>
                          {invalidToolLineCount ? (
                            <Badge variant="secondary">
                              疑似异常 {invalidToolLineCount} 行
                            </Badge>
                          ) : null}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              void copyTextToClipboard(toolOutputText, "提取结果")
                            }
                            disabled={!toolOutputText.trim()}
                          >
                            <CopyIcon data-icon="inline-start" />
                            复制结果
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={handleToolDownload}
                            disabled={!toolOutputText.trim()}
                          >
                            <DownloadIcon data-icon="inline-start" />
                            导出 TXT
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col gap-3 border border-border/70 bg-background/70 px-4 py-4">
                    <p className="text-xs text-muted-foreground">输出字段顺序</p>
                    <div className="flex flex-wrap gap-2">
                      {toolFields.length ? (
                        toolFields.map((field) => (
                          <Badge
                            key={field.key}
                            asChild
                            variant={field.enabled ? "secondary" : "outline"}
                            className="px-0 py-0"
                          >
                            <button
                              type="button"
                              draggable
                              onDragStart={(event) => {
                                event.dataTransfer.effectAllowed = "move"
                                setDraggedToolFieldKey(field.key)
                              }}
                              onDragEnd={() => setDraggedToolFieldKey(null)}
                              onDragOver={(event) => event.preventDefault()}
                              onDragEnter={() => {
                                if (draggedToolFieldKey && draggedToolFieldKey !== field.key) {
                                  moveToolFieldToTarget(draggedToolFieldKey, field.key)
                                }
                              }}
                              onDrop={() => {
                                if (draggedToolFieldKey) {
                                  moveToolFieldToTarget(draggedToolFieldKey, field.key)
                                }
                                setDraggedToolFieldKey(null)
                              }}
                              onClick={() => toggleToolField(field.key, !field.enabled)}
                              className={
                                draggedToolFieldKey === field.key
                                  ? "inline-flex items-center gap-2 px-3 py-1.5 text-xs opacity-60 ring-1 ring-ring/40 transition-all duration-150 cursor-grabbing"
                                  : "inline-flex items-center gap-2 px-3 py-1.5 text-xs transition-all duration-150 cursor-grab hover:bg-muted/50"
                              }
                            >
                              <GripVerticalIcon data-icon="inline-start" />
                              <span>{field.label}</span>
                            </button>
                          </Badge>
                        ))
                      ) : (
                        <div className="text-sm text-muted-foreground">
                          先输入一行数据，系统会根据第一行自动识别字段段数。
                        </div>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="geminipro" className="flex flex-col gap-5">
              {/* Unified card: single input + dual actions */}
              <Card className="border border-border/70 bg-card/92 backdrop-blur">
                <CardHeader className="border-b border-border/70">
                  <CardAction>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setGeminiProNoticesOpen(true)}
                    >
                      <MegaphoneIcon data-icon="inline-start" />
                      使用须知
                    </Button>
                  </CardAction>
                  <CardTitle className="text-xl md:text-2xl">
                    GeminiPro 任务
                  </CardTitle>
                  <CardDescription>
                    输入卡密后可直接查询任务记录；若要提交新账号，点击「提交新任务」打开弹窗填写。
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-5">
                  <form
                    className="flex flex-col gap-4"
                    onSubmit={handleGeminiProSubmit}
                  >
                    <FieldGroup>
                      <Field>
                        <FieldLabel htmlFor="geminipro-code">卡密</FieldLabel>
                        <FieldContent>
                          <Input
                            id="geminipro-code"
                            value={geminiProCode}
                            onChange={(event) =>
                              setGeminiProCode(event.target.value)
                            }
                            placeholder="输入卡密编码"
                            autoComplete="off"
                            className="h-12 text-base"
                          />
                        </FieldContent>
                      </Field>
                    </FieldGroup>
                    <div className="flex flex-wrap items-center gap-3">
                      <Button
                        type="submit"
                        size="lg"
                        disabled={geminiProSubmitting}
                        className="min-w-36"
                      >
                        <SearchIcon data-icon="inline-start" />
                        {geminiProSubmitting ? "查询中..." : "查询记录"}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="lg"
                        onClick={openGeminiProSubmitDialog}
                      >
                        <SparklesIcon data-icon="inline-start" />
                        提交新任务
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="lg"
                        onClick={() => {
                          setGeminiProCode("")
                          setGeminiProResult(null)
                        }}
                      >
                        清空
                      </Button>
                    </div>
                  </form>
                </CardContent>
              </Card>

              {geminiProResult ? (
                (() => {
                  const {
                    items,
                    card_code_obj: card,
                    total,
                    page,
                    page_size: pageSize,
                  } = geminiProResult
                  const pageCount = Math.max(
                    Math.ceil(total / (pageSize || GEMINIPRO_PAGE_SIZE)),
                    1
                  )
                  const remainingQuota = Math.max(
                    0,
                    (card?.total_quota || 0) - (card?.used_quota || 0)
                  )

                  return (
                    <Card className="border border-border/70 bg-card/92 backdrop-blur">
                      <CardHeader className="border-b border-border/70">
                        <CardAction>
                          <Popover>
                            <PopoverTrigger asChild>
                              <Button variant="outline" size="sm">
                                <InfoIcon data-icon="inline-start" />
                                剩余 {remainingQuota}
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent
                              align="end"
                              className="w-64"
                            >
                              <div className="grid grid-cols-3 gap-2 text-center">
                                <div className="flex flex-col gap-0.5 border border-border/70 bg-background/60 px-2 py-2">
                                  <span className="text-[10px] text-muted-foreground">
                                    总额度
                                  </span>
                                  <span className="font-heading text-base font-medium text-foreground">
                                    {card?.total_quota ?? "-"}
                                  </span>
                                </div>
                                <div className="flex flex-col gap-0.5 border border-border/70 bg-background/60 px-2 py-2">
                                  <span className="text-[10px] text-muted-foreground">
                                    已使用
                                  </span>
                                  <span className="font-heading text-base font-medium text-foreground">
                                    {card?.used_quota ?? "-"}
                                  </span>
                                </div>
                                <div className="flex flex-col gap-0.5 border border-border/70 bg-background/60 px-2 py-2">
                                  <span className="text-[10px] text-muted-foreground">
                                    剩余
                                  </span>
                                  <span className="font-heading text-base font-medium text-primary">
                                    {remainingQuota}
                                  </span>
                                </div>
                              </div>
                            </PopoverContent>
                          </Popover>
                        </CardAction>
                        <CardTitle>任务记录</CardTitle>
                        <CardDescription>
                          共 {total} 条任务，当前展示第 {page} / {pageCount} 页。
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="flex flex-col gap-5">
                        {items.length ? (
                          <>
                            {/* Desktop table */}
                            <div className="hidden overflow-hidden border border-border/70 md:block">
                              <Table>
                                <TableHeader>
                                  <TableRow>
                                    <TableHead className="w-16">#</TableHead>
                                    <TableHead>账号信息</TableHead>
                                    <TableHead className="w-24">状态</TableHead>
                                    <TableHead>结果</TableHead>
                                    <TableHead className="w-40">提交时间</TableHead>
                                    <TableHead className="w-40">完成时间</TableHead>
                                    <TableHead className="w-28 text-right">
                                      操作
                                    </TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {items.map((task) => (
                                    <TableRow key={task.id}>
                                      <TableCell className="text-muted-foreground">
                                        {task.id}
                                      </TableCell>
                                      <TableCell>
                                        <code className="font-mono text-[11px] break-all whitespace-normal">
                                          {task.account_info || "-"}
                                        </code>
                                      </TableCell>
                                      <TableCell>
                                        <GeminiProStatusBadge task={task} />
                                      </TableCell>
                                      <TableCell className="whitespace-normal">
                                        {task.result || "-"}
                                      </TableCell>
                                      <TableCell className="text-xs text-muted-foreground">
                                        {formatDateTime(task.submitted_at)}
                                      </TableCell>
                                      <TableCell className="text-xs text-muted-foreground">
                                        {formatDateTime(task.completed_at)}
                                      </TableCell>
                                      <TableCell className="text-right">
                                        {task.is_you_hui_url &&
                                        task.you_hui_url ? (
                                          <Button
                                            variant="outline"
                                            size="xs"
                                            asChild
                                          >
                                            <a
                                              href={task.you_hui_url}
                                              target="_blank"
                                              rel="noreferrer"
                                            >
                                              <ExternalLinkIcon data-icon="inline-start" />
                                              打开
                                            </a>
                                          </Button>
                                        ) : (
                                          <span className="text-xs text-muted-foreground">
                                            -
                                          </span>
                                        )}
                                      </TableCell>
                                    </TableRow>
                                  ))}
                                </TableBody>
                              </Table>
                            </div>

                            {/* Mobile card list */}
                            <div className="flex flex-col gap-3 md:hidden">
                              {items.map((task) => (
                                <div
                                  key={task.id}
                                  className="flex flex-col gap-2 border border-border/70 bg-background/60 px-3 py-3"
                                >
                                  <div className="flex items-start justify-between gap-2">
                                    <span className="text-xs text-muted-foreground">
                                      #{task.id}
                                    </span>
                                    <GeminiProStatusBadge task={task} />
                                  </div>
                                  <code className="font-mono text-[11px] break-all text-foreground/90">
                                    {task.account_info || "-"}
                                  </code>
                                  {task.result ? (
                                    <p className="text-xs text-foreground/90">
                                      {task.result}
                                    </p>
                                  ) : null}
                                  <div className="grid grid-cols-2 gap-2 text-[11px] text-muted-foreground">
                                    <div>
                                      <div>提交</div>
                                      <div className="text-foreground/80">
                                        {formatDateTime(task.submitted_at)}
                                      </div>
                                    </div>
                                    <div>
                                      <div>完成</div>
                                      <div className="text-foreground/80">
                                        {formatDateTime(task.completed_at)}
                                      </div>
                                    </div>
                                  </div>
                                  {task.is_you_hui_url && task.you_hui_url ? (
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      asChild
                                      className="self-start"
                                    >
                                      <a
                                        href={task.you_hui_url}
                                        target="_blank"
                                        rel="noreferrer"
                                      >
                                        <ExternalLinkIcon data-icon="inline-start" />
                                        打开优惠链接
                                      </a>
                                    </Button>
                                  ) : null}
                                </div>
                              ))}
                            </div>
                          </>
                        ) : (
                          <Alert>
                            <SearchIcon />
                            <AlertTitle>暂无任务记录</AlertTitle>
                            <AlertDescription>
                              该卡密目前还没有任何任务记录。
                            </AlertDescription>
                          </Alert>
                        )}

                        {pageCount > 1 ? (
                          <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                            <span>
                              第 {page} / {pageCount} 页
                            </span>
                            <div className="flex gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={geminiProSubmitting || page <= 1}
                                onClick={() =>
                                  void handleGeminiProPageChange(page - 1)
                                }
                              >
                                上一页
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={
                                  geminiProSubmitting || page >= pageCount
                                }
                                onClick={() =>
                                  void handleGeminiProPageChange(page + 1)
                                }
                              >
                                下一页
                              </Button>
                            </div>
                          </div>
                        ) : null}
                      </CardContent>
                    </Card>
                  )
                })()
              ) : null}
            </TabsContent>
          </Tabs>

          {faq?.html && activeTab !== "geminipro" ? (
            <Card className="border border-border/70 bg-card/92 backdrop-blur">
              <CardContent>
                <RichTextContent html={faq.html} />
              </CardContent>
            </Card>
          ) : null}
        </section>
      </div>

      <Dialog
        open={geminiProNoticesOpen}
        onOpenChange={setGeminiProNoticesOpen}
      >
        <DialogContent className="max-w-[min(96vw,40rem)] p-0 sm:max-w-[min(96vw,40rem)]">
          <DialogHeader className="border-b border-border/70 px-5 py-4">
            <DialogTitle className="flex items-center gap-2">
              <MegaphoneIcon className="size-4 text-primary" />
              GeminiPro 使用须知
            </DialogTitle>
            <DialogDescription>
              认真阅读以下内容可以显著降低处理失败的概率。
            </DialogDescription>
          </DialogHeader>
          <div className="flex max-h-[min(72svh,36rem)] min-h-0 flex-col gap-4 overflow-y-auto px-5 py-4">
            {/* Pre-flight preparation */}
            <section className="flex flex-col gap-2">
              <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
                ⚠️ 提交前请务必完成以下两步
              </p>
              <div className="grid gap-2 md:grid-cols-2">
                <a
                  href="https://flowus.cn/share/d44718c5-7187-406f-b767-f29884932b37?code=U5NARY"
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 border border-border/70 bg-background/60 px-3 py-2 text-xs transition hover:border-primary/60 hover:bg-background"
                >
                  <ShieldCheckIcon className="size-4 shrink-0 text-primary" />
                  <span className="flex-1 font-medium text-foreground">
                    1. 开启两步验证
                  </span>
                  <ExternalLinkIcon className="size-3.5 text-muted-foreground" />
                </a>
                <a
                  href="https://flowus.cn/share/3b3666b8-3bfb-4594-a8eb-7b7780cf9ff1?code=U5NARY"
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 border border-border/70 bg-background/60 px-3 py-2 text-xs transition hover:border-primary/60 hover:bg-background"
                >
                  <ShieldCheckIcon className="size-4 shrink-0 text-primary" />
                  <span className="flex-1 font-medium text-foreground">
                    2. 关闭支付资料
                  </span>
                  <ExternalLinkIcon className="size-3.5 text-muted-foreground" />
                </a>
              </div>
            </section>

            {/* Usage rules */}
            <section className="flex flex-col gap-2">
              <p className="text-xs font-medium text-foreground">📢 使用须知</p>
              <ul className="flex flex-col gap-2">
                <li className="flex flex-col gap-0.5 border border-border/70 bg-background/60 px-3 py-2 text-xs">
                  <div className="flex items-center gap-1.5 font-medium text-foreground">
                    <span>🌍 地区 / 年龄</span>
                    <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                      必须
                    </Badge>
                  </div>
                  <span className="text-muted-foreground">
                    账号必须在支持区域内且通过年龄验证。
                  </span>
                </li>
                <li className="flex flex-col gap-0.5 border border-border/70 bg-background/60 px-3 py-2 text-xs">
                  <div className="flex items-center gap-1.5 font-medium text-foreground">
                    <span>👪 家庭组限制</span>
                  </div>
                  <span className="text-muted-foreground">
                    若已在家庭组，需确保组内无有效订阅。
                  </span>
                </li>
                <li className="flex flex-col gap-0.5 border border-border/70 bg-background/60 px-3 py-2 text-xs">
                  <div className="flex items-center gap-1.5 font-medium text-foreground">
                    <span>⚠️ 新号风险</span>
                    <Badge variant="destructive" className="h-4 px-1.5 text-[10px]">
                      高风险
                    </Badge>
                  </div>
                  <span className="text-muted-foreground">
                    新注册极易触发风控/封禁，强烈建议使用老号。
                  </span>
                </li>
                <li className="flex flex-col gap-0.5 border border-border/70 bg-background/60 px-3 py-2 text-xs">
                  <div className="flex items-center gap-1.5 font-medium text-foreground">
                    <span>🔐 账号安全</span>
                  </div>
                  <span className="text-muted-foreground">
                    处理后及时改密码或绑定 2FA，避免纠纷。
                  </span>
                </li>
                <li className="flex flex-col gap-0.5 border border-border/70 bg-background/60 px-3 py-2 text-xs">
                  <div className="flex items-center gap-1.5 font-medium text-foreground">
                    <span>🕒 网络延迟</span>
                  </div>
                  <span className="text-muted-foreground">
                    住宅代理较慢，失败请多重试。
                  </span>
                </li>
              </ul>
            </section>
          </div>
          <DialogFooter className="border-t border-border/70 px-5 py-4">
            <Button
              type="button"
              onClick={() => setGeminiProNoticesOpen(false)}
            >
              我已了解
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={geminiProSubmitDialogOpen}
        onOpenChange={setGeminiProSubmitDialogOpen}
      >
        <DialogContent className="max-w-[min(96vw,44rem)] p-0 sm:max-w-[min(96vw,44rem)]">
          <DialogHeader className="border-b border-border/70 px-5 py-4">
            <DialogTitle>提交新任务</DialogTitle>
            <DialogDescription>
              为卡密{" "}
              <code className="font-mono text-foreground">
                {geminiProCode || "(未填写)"}
              </code>{" "}
              添加一组或多组账号，每组需包含账号、密码、32 位 2FA 密钥。
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleGeminiProTaskSubmit}>
            <div className="flex max-h-[min(70svh,32rem)] min-h-0 flex-col gap-4 overflow-y-auto px-5 py-4">
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  账号列表（账号 / 密码 / 2FA 密钥）
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={addGeminiProAccountRow}
                >
                  <PlusIcon data-icon="inline-start" />
                  新增一行
                </Button>
              </div>

              <div className="flex flex-col gap-3">
                {geminiProAccounts.map((row, index) => (
                  <div
                    key={row.key}
                    className="flex flex-col gap-2 border border-border/70 bg-background/60 px-3 py-3"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-medium text-muted-foreground">
                        #{index + 1}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label="删除该行"
                        onClick={() => removeGeminiProAccountRow(row.key)}
                      >
                        <Trash2Icon />
                      </Button>
                    </div>
                    <div className="grid gap-2 md:grid-cols-3">
                      <Input
                        value={row.account}
                        onChange={(event) =>
                          updateGeminiProAccount(
                            row.key,
                            "account",
                            event.target.value
                          )
                        }
                        placeholder="账号"
                        autoComplete="off"
                      />
                      <Input
                        value={row.password}
                        onChange={(event) =>
                          updateGeminiProAccount(
                            row.key,
                            "password",
                            event.target.value
                          )
                        }
                        placeholder="密码"
                        autoComplete="off"
                      />
                      <Input
                        value={row.totp}
                        onChange={(event) =>
                          updateGeminiProAccount(
                            row.key,
                            "totp",
                            event.target.value
                          )
                        }
                        placeholder="2FA 密钥（32 位）"
                        autoComplete="off"
                        maxLength={48}
                        className="font-mono"
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <DialogFooter className="border-t border-border/70 px-5 py-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => setGeminiProSubmitDialogOpen(false)}
              >
                取消
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() =>
                  setGeminiProAccounts([createGeminiProAccountRow()])
                }
              >
                重置
              </Button>
              <Button type="submit" disabled={geminiProTaskSubmitting}>
                <SparklesIcon data-icon="inline-start" />
                {geminiProTaskSubmitting ? "提交中..." : "提交任务"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </main>
  )
}
