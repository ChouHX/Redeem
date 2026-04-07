import { useEffect, useState, type Dispatch, type SetStateAction } from "react"
import {
  CheckCircle2Icon,
  CopyIcon,
  DownloadIcon,
  MailIcon,
  RefreshCcwIcon,
  SearchIcon,
  TicketIcon,
} from "lucide-react"

import {
  ApiError,
  type RedeemCatalog,
  type RedeemExchangeResult,
  type RedeemOrderQueryResult,
  exchangeRedeemCode,
  fetchRedeemCatalog,
  queryRedeemOrder,
} from "@/lib/api"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
import { Skeleton } from "@/components/ui/skeleton"
import { ThemeToggle } from "@/components/theme-toggle"
import { Textarea } from "@/components/ui/textarea"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { createTextExportFilename, downloadTextFile } from "@/lib/utils"

type NoticeState = {
  title: string
  description: string
  variant?: "default" | "destructive"
}

type ResultLineItem = {
  formatted_line: string
}

const MAX_VISIBLE_RESULT_ITEMS = 10

function totalAvailableInventory(types: RedeemCatalog["types"]) {
  return types.reduce((sum, item) => sum + item.available_inventory_count, 0)
}

function totalAvailableCodes(types: RedeemCatalog["types"]) {
  return types.reduce((sum, item) => sum + item.available_code_count, 0)
}

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

async function copyTextToClipboard(
  value: string,
  label: string,
  setTargetNotice: Dispatch<SetStateAction<NoticeState | null>>
) {
  try {
    await navigator.clipboard.writeText(value)
    setTargetNotice({
      title: "复制成功",
      description: `${label} 已复制到剪贴板`,
    })
  } catch {
    setTargetNotice({
      title: "复制失败",
      description: "当前浏览器不支持自动复制，请手动复制。",
      variant: "destructive",
    })
  }
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
  setNotice,
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
  setNotice: Dispatch<SetStateAction<NoticeState | null>>
  downloadPrefix: string
}) {
  const visibleItems = items.slice(0, MAX_VISIBLE_RESULT_ITEMS)
  const hiddenItemCount = Math.max(0, items.length - MAX_VISIBLE_RESULT_ITEMS)
  const visibleText = buildResultText(visibleItems)
  const fullText = buildResultText(items)

  function handleDownload() {
    downloadTextFile(fullText, createTextExportFilename(downloadPrefix, code))
    setNotice({
      title: "下载成功",
      description: `已下载 ${itemCount} 条结果内容。`,
    })
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
            onClick={() => void copyTextToClipboard(code, "兑换码", setNotice)}
          >
            <CopyIcon data-icon="inline-start" />
            复制卡密
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void copyTextToClipboard(fullText, "结果内容", setNotice)}
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
  const [activeTab, setActiveTab] = useState("exchange")
  const [exchangeResult, setExchangeResult] = useState<RedeemExchangeResult | null>(null)
  const [exchangeCode, setExchangeCode] = useState("")
  const [queryCode, setQueryCode] = useState("")
  const [queryResult, setQueryResult] = useState<RedeemOrderQueryResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [exchangeSubmitting, setExchangeSubmitting] = useState(false)
  const [querySubmitting, setQuerySubmitting] = useState(false)
  const [exchangeNotice, setExchangeNotice] = useState<NoticeState | null>(null)
  const [queryNotice, setQueryNotice] = useState<NoticeState | null>(null)

  async function loadCatalog() {
    setLoading(true)
    try {
      const nextCatalog = await fetchRedeemCatalog()
      setCatalog(nextCatalog.types)
    } catch (error) {
      setExchangeNotice({
        title: "加载失败",
        description: formatErrorMessage(error),
        variant: "destructive",
      })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadCatalog()
  }, [])

  async function handleExchange(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextCode = exchangeCode.trim()
    if (!nextCode) {
      setExchangeNotice({
        title: "请输入兑换码",
        description: "卡密不能为空。",
        variant: "destructive",
      })
      return
    }

    setExchangeSubmitting(true)
    setExchangeNotice(null)

    try {
      const payload = await exchangeRedeemCode(nextCode)
      setExchangeResult(payload.data)
      setExchangeCode("")
      setQueryCode(payload.data.code)
      setExchangeNotice({
        title: "兑换成功",
        description: "邮箱数据已发放，请尽快复制保存。",
      })
      await loadCatalog()
    } catch (error) {
      setExchangeResult(null)
      setExchangeNotice({
        title: "兑换失败",
        description: formatErrorMessage(error),
        variant: "destructive",
      })
    } finally {
      setExchangeSubmitting(false)
    }
  }

  async function handleQuery(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextCode = queryCode.trim()
    if (!nextCode) {
      setQueryNotice({
        title: "请输入兑换码",
        description: "订单查询需要兑换码。",
        variant: "destructive",
      })
      return
    }

    setQuerySubmitting(true)
    setQueryNotice(null)

    try {
      const payload = await queryRedeemOrder(nextCode)
      setQueryResult(payload)
      setQueryNotice({
        title: "查询成功",
        description: "已载入该兑换码对应的已兑换订单。",
      })
    } catch (error) {
      setQueryResult(null)
      setQueryNotice({
        title: "查询失败",
        description: formatErrorMessage(error),
        variant: "destructive",
      })
    } finally {
      setQuerySubmitting(false)
    }
  }

  return (
    <main className="page-shell page-shell-redeem relative min-h-svh overflow-hidden">
      <div className="redeem-noise pointer-events-none absolute inset-0 opacity-70" />
      <div className="relative mx-auto flex min-h-svh w-full max-w-6xl flex-col gap-6 px-4 py-6 md:px-6 lg:px-8">
        <header className="flex flex-col gap-4 border-b border-border/70 pb-5 md:flex-row md:items-center md:justify-between">
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
        </header>

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
                  <div className="grid gap-3 md:grid-cols-3">
                    {loading ? (
                      Array.from({ length: 3 }).map((_, index) => (
                        <Skeleton key={index} className="h-18 w-full" />
                      ))
                    ) : (
                      <>
                        <Card size="sm" className="border border-border/70 bg-background/70">
                          <CardHeader className="border-b border-border/70">
                            <CardTitle>类型</CardTitle>
                          </CardHeader>
                          <CardContent>
                            <p className="font-heading text-2xl font-medium">{catalog.length}</p>
                          </CardContent>
                        </Card>
                        <Card size="sm" className="border border-border/70 bg-background/70">
                          <CardHeader className="border-b border-border/70">
                            <CardTitle>库存</CardTitle>
                          </CardHeader>
                          <CardContent>
                            <p className="font-heading text-2xl font-medium">
                              {totalAvailableInventory(catalog)}
                            </p>
                          </CardContent>
                        </Card>
                        <Card size="sm" className="border border-border/70 bg-background/70">
                          <CardHeader className="border-b border-border/70">
                            <CardTitle>卡密</CardTitle>
                          </CardHeader>
                          <CardContent>
                            <p className="font-heading text-2xl font-medium">
                              {totalAvailableCodes(catalog)}
                            </p>
                          </CardContent>
                        </Card>
                      </>
                    )}
                  </div>

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
                          setExchangeNotice(null)
                        }}
                      >
                        清空
                      </Button>
                    </div>
                  </form>

                  {exchangeNotice ? (
                    <Alert variant={exchangeNotice.variant}>
                      {exchangeNotice.variant === "destructive" ? (
                        <TicketIcon />
                      ) : (
                        <CheckCircle2Icon />
                      )}
                      <AlertTitle>{exchangeNotice.title}</AlertTitle>
                      <AlertDescription>{exchangeNotice.description}</AlertDescription>
                    </Alert>
                  ) : null}
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
                  setNotice={setExchangeNotice}
                  downloadPrefix="redeem_result"
                />
              ) : null}

              {!loading && catalog.length ? (
                <Card className="border border-border/70 bg-card/88 backdrop-blur">
                  <CardHeader className="border-b border-border/70">
                    <CardTitle>开放类型</CardTitle>
                    <CardDescription>仅展示可兑换类型与字段顺序。</CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-4">
                    {catalog.map((type) => (
                      <div
                        key={type.id}
                        className="flex flex-col gap-2 border border-border/70 bg-background/70 px-3 py-3"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline">{type.name}</Badge>
                          <Badge variant="secondary">
                            库存 {type.available_inventory_count}
                          </Badge>
                          <Badge variant="secondary">卡密 {type.available_code_count}</Badge>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {type.field_schema.map((field) => (
                            <Badge key={`${type.id}-${field.key}`} variant="outline">
                              {field.label}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    ))}
                  </CardContent>
                </Card>
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
                          setQueryNotice(null)
                        }}
                      >
                        清空
                      </Button>
                    </div>
                  </form>

                  {queryNotice ? (
                    <Alert variant={queryNotice.variant}>
                      {queryNotice.variant === "destructive" ? (
                        <SearchIcon />
                      ) : (
                        <CheckCircle2Icon />
                      )}
                      <AlertTitle>{queryNotice.title}</AlertTitle>
                      <AlertDescription>{queryNotice.description}</AlertDescription>
                    </Alert>
                  ) : null}
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
                  setNotice={setQueryNotice}
                  downloadPrefix="redeem_order"
                />
              ) : null}
            </TabsContent>
          </Tabs>
        </section>
      </div>
    </main>
  )
}
