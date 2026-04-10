import { useEffect, useState } from "react"
import {
  CopyIcon,
  DownloadIcon,
  GripVerticalIcon,
  MailIcon,
  RefreshCcwIcon,
  SearchIcon,
  TicketIcon,
  WrenchIcon,
} from "lucide-react"

import {
  type AdSlotConfig,
  ApiError,
  type RedeemCatalog,
  type RedeemExchangeResult,
  type RedeemOrderQueryResult,
  exchangeRedeemCode,
  fetchPublicAds,
  fetchRedeemCatalog,
  queryRedeemOrder,
} from "@/lib/api"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { AdSlotCard } from "@/components/ad-slot-card"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field, FieldContent, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
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
                              key={field.key}
                              onDragStart={() => setDraggedToolFieldKey(field.key)}
                              onDragEnd={() => setDraggedToolFieldKey(null)}
                              onDragOver={(event) => event.preventDefault()}
                              onDragEnter={() => {
                                if (draggedToolFieldKey) {
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
                              className="inline-flex items-center gap-2 px-3 py-1.5 text-xs transition-transform duration-150"
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
          </Tabs>
        </section>
      </div>
    </main>
  )
}
