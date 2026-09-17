import { useEffect, useRef, useState } from "react"
import {
  ClockIcon,
  CopyIcon,
  DownloadIcon,
  MailIcon,
  RefreshCcwIcon,
  SearchIcon,
  ShieldCheckIcon,
  TicketIcon,
  TriangleAlertIcon,
  WrenchIcon,
} from "lucide-react"

import {
  ApiError,
  type AdSlotConfig,
  type FaqConfig,
  type MailProtocol,
  type RedeemCatalog,
  type RedeemExchangeResult,
  type RedeemOrderQueryResult,
  exchangeRedeemCode,
  fetchPublicAds,
  fetchPublicFaq,
  fetchRedeemCatalog,
  queryRedeemOrder,
} from "@/lib/api"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { AdSlotCard } from "@/components/ad-slot-card"
import { ToolsTab } from "@/components/tools-tab"
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
  Field,
  FieldContent,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { ThemeToggle } from "@/components/theme-toggle"
import { Textarea } from "@/components/ui/textarea"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { createTextExportFilename, downloadTextFile } from "@/lib/utils"
import {
  copyTextToClipboard,
  formatDateTime,
  formatErrorMessage,
  notify,
} from "@/lib/shared"

type ResultLineItem = {
  formatted_line: string
}

const MAX_VISIBLE_RESULT_ITEMS = 10

const MAIL_PROTOCOL_INFO: Record<
  MailProtocol,
  { label: string; hint: string }
> = {
  imap: {
    label: "IMAP",
    hint: "可用标准 IMAP 客户端或本站「用户收件」取件。",
  },
  graph: {
    label: "Graph",
    hint: "可用 Microsoft Graph API 取件，读取速度通常更快。",
  },
}

function buildResultText(items: ResultLineItem[]) {
  return items.map((item) => item.formatted_line).join("\n")
}

// 只信账号级协议：顶层汇总为首选，条目协议作兜底。
// 类型级协议（result.type.mail_protocols）只是该类型的允许范围，
// 混进来会让兑换页显示账号实际并不支持的取件方式。
function collectMailProtocols(
  result: RedeemExchangeResult | null
): MailProtocol[] {
  if (!result) {
    return []
  }

  const collected = [
    ...(result.mail_protocols || []),
    ...result.items.flatMap((item) => item.mail_protocols || []),
  ].filter((protocol): protocol is MailProtocol => Boolean(protocol))

  return (["imap", "graph"] as MailProtocol[]).filter((protocol) =>
    collected.includes(protocol)
  )
}

function downloadResultItems(
  items: ResultLineItem[],
  code: string,
  downloadPrefix: string
) {
  downloadTextFile(
    buildResultText(items),
    createTextExportFilename(downloadPrefix, code)
  )
  notify("下载成功", `已下载 ${items.length} 条结果内容。`)
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
  emphasized = false,
  protocols = [],
  retentionHours,
  expiresAt,
  onOpenReminder,
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
  emphasized?: boolean
  protocols?: MailProtocol[]
  retentionHours?: number
  expiresAt?: string
  onOpenReminder?: () => void
}) {
  const visibleItems = items.slice(0, MAX_VISIBLE_RESULT_ITEMS)
  const hiddenItemCount = Math.max(0, items.length - MAX_VISIBLE_RESULT_ITEMS)
  const visibleText = buildResultText(visibleItems)
  const fullText = buildResultText(items)

  function handleDownload() {
    downloadResultItems(items, code, downloadPrefix)
  }

  return (
    <Card
      className={
        emphasized
          ? "border border-primary/30 bg-card/97 shadow-sm"
          : "border border-border/70 bg-card/97"
      }
    >
      <CardHeader
        className={
          emphasized
            ? "gap-2 border-b border-border/70 pb-3"
            : "border-b border-border/70"
        }
      >
        {emphasized ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 items-start gap-2.5">
              <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/12 text-primary">
                <ShieldCheckIcon className="size-4" />
              </div>
              <div className="flex min-w-0 flex-col gap-0.5">
                <CardTitle className="text-lg md:text-xl">{title}</CardTitle>
                <CardDescription className="max-w-2xl text-xs/normal">
                  {description}
                </CardDescription>
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground sm:max-w-64 sm:justify-end">
              <Badge variant="secondary" className="h-5 px-1.5 text-[11px]">
                {badgeLabel}
              </Badge>
              <span className="font-medium text-foreground">{typeName}</span>
              <span aria-hidden="true">·</span>
              <span>{itemCount} 条数据</span>
              <span aria-hidden="true">·</span>
              <span>{formatDateTime(redeemedAt)}</span>
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge>{badgeLabel}</Badge>
              <Badge variant="outline">{typeName}</Badge>
              <Badge variant="outline">数量 {itemCount}</Badge>
              <Badge variant="secondary">{formatDateTime(redeemedAt)}</Badge>
            </div>
            <CardTitle>{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {emphasized ? (
          <div className="flex flex-col gap-3 border border-border/70 bg-muted/30 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">取件协议</span>
                {protocols.length ? (
                  protocols.map((protocol) => (
                    <Badge key={protocol} variant="outline">
                      {MAIL_PROTOCOL_INFO[protocol].label}
                    </Badge>
                  ))
                ) : (
                  <Badge variant="outline">未标注</Badge>
                )}
              </div>
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <ClockIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  {retentionHours || 24} 小时后自动删除
                  {expiresAt ? ` · ${formatDateTime(expiresAt)}` : ""}
                </span>
              </p>
            </div>
            {onOpenReminder ? (
              <button
                type="button"
                className="w-fit text-xs text-primary underline-offset-4 hover:underline"
                onClick={onOpenReminder}
              >
                查看提醒
              </button>
            ) : null}
          </div>
        ) : null}

        <div
          className={
            emphasized
              ? "flex flex-wrap gap-2"
              : "flex flex-wrap justify-end gap-2"
          }
        >
          <Button
            variant={emphasized ? "default" : "outline"}
            size="sm"
            onClick={() => void copyTextToClipboard(fullText, "结果内容")}
          >
            <CopyIcon data-icon="inline-start" />
            {emphasized ? "复制全部结果" : "复制结果"}
          </Button>
          <Button
            variant={emphasized ? "secondary" : "outline"}
            size="sm"
            onClick={handleDownload}
          >
            <DownloadIcon data-icon="inline-start" />
            {emphasized ? "下载 TXT 保存" : "下载 TXT"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void copyTextToClipboard(code, "兑换码")}
          >
            <CopyIcon data-icon="inline-start" />
            复制卡密
          </Button>
        </div>

        {hiddenItemCount > 0 ? (
          <Alert>
            <SearchIcon />
            <AlertTitle>仅展示前 10 条</AlertTitle>
            <AlertDescription>
              当前结果共 {itemCount} 条，剩余 {hiddenItemCount}{" "}
              条已隐藏，请使用下载按钮查看完整内容。
            </AlertDescription>
          </Alert>
        ) : null}

        <div className={emphasized ? "flex flex-col gap-2" : undefined}>
          {emphasized ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium text-foreground">账号数据</p>
              <p className="text-xs text-muted-foreground">
                请复制或下载后妥善保存
              </p>
            </div>
          ) : null}
          <Textarea
            value={visibleText}
            readOnly
            rows={Math.max(
              6,
              Math.min(MAX_VISIBLE_RESULT_ITEMS + 1, visibleItems.length + 1)
            )}
            wrap="off"
            spellCheck={false}
            className={`resize-y overflow-x-scroll overflow-y-auto font-mono text-xs leading-6 ${
              emphasized ? "min-h-40 bg-background" : "min-h-64"
            }`}
          />
        </div>
      </CardContent>
    </Card>
  )
}

export function RedeemConsole() {
  const redeemResultRef = useRef<HTMLDivElement | null>(null)
  const [catalog, setCatalog] = useState<RedeemCatalog["types"]>([])
  const [adSlot, setAdSlot] = useState<AdSlotConfig | null>(null)
  const [faq, setFaq] = useState<FaqConfig | null>(null)
  const [activeTab, setActiveTab] = useState("exchange")
  const [exchangeResult, setExchangeResult] =
    useState<RedeemExchangeResult | null>(null)
  const [exchangeCode, setExchangeCode] = useState("")
  const [queryCode, setQueryCode] = useState("")
  const [queryResult, setQueryResult] = useState<RedeemOrderQueryResult | null>(
    null
  )
  const [loading, setLoading] = useState(true)
  const [exchangeSubmitting, setExchangeSubmitting] = useState(false)
  const [querySubmitting, setQuerySubmitting] = useState(false)
  const [redeemReminderOpen, setRedeemReminderOpen] = useState(false)

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
      setRedeemReminderOpen(false)
      setExchangeResult(payload.data)
      setExchangeCode("")
      setQueryCode(payload.data.code)
      await revealRedeemResult("auto")
      setRedeemReminderOpen(true)
      notify("兑换成功", "邮箱数据已发放，请尽快复制保存。")
      await loadCatalog()
    } catch (error) {
      setExchangeResult(null)
      setRedeemReminderOpen(false)
      notify(
        error instanceof ApiError && error.status === 410
          ? "账号信息已删除"
          : "兑换失败",
        formatErrorMessage(error),
        "destructive"
      )
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
      notify(
        error instanceof ApiError && error.status === 410
          ? "账号信息已删除"
          : "查询失败",
        formatErrorMessage(error),
        "destructive"
      )
    } finally {
      setQuerySubmitting(false)
    }
  }

  const redeemProtocols = collectMailProtocols(exchangeResult)
  const redeemRetentionHours = exchangeResult?.access_ttl_hours || 24
  const redeemExpiresAt = exchangeResult?.access_expires_at || ""

  function revealRedeemResult(behavior: ScrollBehavior = "smooth") {
    return new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => {
        redeemResultRef.current?.scrollIntoView({
          behavior,
          block: "start",
        })

        // Give the browser one frame to apply the new scroll position before a
        // modal locks page scrolling.
        window.requestAnimationFrame(() => resolve())
      })
    })
  }

  function handleRedeemReminderOpenChange(open: boolean) {
    setRedeemReminderOpen(open)
    if (!open) {
      revealRedeemResult()
    }
  }

  function handleReminderDownload() {
    if (!exchangeResult) {
      return
    }

    downloadResultItems(
      exchangeResult.items,
      exchangeResult.code,
      "redeem_result"
    )
    setRedeemReminderOpen(false)
    revealRedeemResult()
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
                  用户收件
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
            <div className="[scrollbar-width:none] overflow-x-auto pb-1 [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
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
              <Card className="border border-border/70 bg-card/97">
                <CardHeader className="border-b border-border/70">
                  <CardAction>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => void loadCatalog()}
                    >
                      <RefreshCcwIcon />
                      <span className="sr-only">刷新</span>
                    </Button>
                  </CardAction>
                  <CardTitle className="text-xl md:text-2xl">
                    输入兑换码
                  </CardTitle>
                  <CardDescription>
                    支持大小写混输，每个兑换码仅可使用一次。
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-5">
                  <form
                    className="flex flex-col gap-4"
                    onSubmit={handleExchange}
                  >
                    <FieldGroup>
                      <Field>
                        <FieldLabel htmlFor="redeem-code">兑换码</FieldLabel>
                        <FieldContent>
                          <Input
                            id="redeem-code"
                            value={exchangeCode}
                            onChange={(event) =>
                              setExchangeCode(event.target.value)
                            }
                            placeholder="例如 MAIL-ABCD-EFGH-JKLM"
                            autoComplete="off"
                            className="h-12 text-base"
                          />
                        </FieldContent>
                      </Field>
                    </FieldGroup>
                    {!loading && catalog.length ? (
                      <div className="flex flex-col gap-2">
                        <p className="text-xs text-muted-foreground">
                          可兑类型
                        </p>
                        <div className="flex flex-wrap gap-2 text-xs text-foreground/80">
                          {catalog.map((type) => (
                            <span
                              key={type.id}
                              className="border border-border/70 px-2 py-1"
                            >
                              {type.name} · 库存{" "}
                              {type.available_inventory_count}
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
                <div ref={redeemResultRef} className="scroll-mt-4">
                  <ResultOutputCard
                    badgeLabel="兑换成功 · 已发放"
                    title="兑换结果"
                    description="请立即复制或下载账号数据，并确认本次账号支持的取件协议。"
                    code={exchangeResult.code}
                    typeName={exchangeResult.type.name}
                    itemCount={exchangeResult.redeemed_count}
                    redeemedAt={exchangeResult.redeemed_at}
                    items={exchangeResult.items}
                    downloadPrefix="redeem_result"
                    emphasized
                    protocols={redeemProtocols}
                    retentionHours={redeemRetentionHours}
                    expiresAt={redeemExpiresAt}
                    onOpenReminder={() => setRedeemReminderOpen(true)}
                  />
                </div>
              ) : null}
            </TabsContent>

            <TabsContent value="orders" className="flex flex-col gap-5">
              <Card className="border border-border/70 bg-card/97">
                <CardHeader className="border-b border-border/70">
                  <CardTitle className="text-xl md:text-2xl">
                    订单查询
                  </CardTitle>
                  <CardDescription>
                    输入已兑换的兑换码，查看对应订单内容。若超过 10 条，仅展示前
                    10 条。
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-5">
                  <form className="flex flex-col gap-4" onSubmit={handleQuery}>
                    <FieldGroup>
                      <Field>
                        <FieldLabel htmlFor="redeem-order-code">
                          兑换码
                        </FieldLabel>
                        <FieldContent>
                          <Input
                            id="redeem-order-code"
                            value={queryCode}
                            onChange={(event) =>
                              setQueryCode(event.target.value)
                            }
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
              <ToolsTab onQueryCodeChange={setQueryCode} />
            </TabsContent>
          </Tabs>

          {faq?.html && activeTab !== "tools" ? (
            <Card className="border border-border/70 bg-card/97">
              <CardContent>
                <RichTextContent html={faq.html} />
              </CardContent>
            </Card>
          ) : null}
        </section>
      </div>

      <Dialog
        open={redeemReminderOpen && Boolean(exchangeResult)}
        onOpenChange={handleRedeemReminderOpenChange}
      >
        <DialogContent className="max-w-[min(96vw,34rem)] p-0 sm:max-w-[min(96vw,34rem)]">
          <DialogHeader className="border-b border-border/70 px-5 py-4">
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheckIcon className="size-4 text-primary" />
              兑换完成提醒
            </DialogTitle>
            <DialogDescription>
              本次共发放 {exchangeResult?.redeemed_count ?? 0} 条账号数据，请先确认取件方式与保留时间。
            </DialogDescription>
          </DialogHeader>
          <div className="flex max-h-[min(70svh,32rem)] min-h-0 flex-col gap-4 overflow-y-auto px-5 py-4">
            <section className="flex flex-col gap-2">
              <p className="text-xs font-medium text-foreground">
                本次账号支持的取件协议
              </p>
              {redeemProtocols.length ? (
                <ul className="flex flex-col gap-2">
                  {redeemProtocols.map((protocol) => (
                    <li
                      key={protocol}
                      className="flex flex-col gap-0.5 border border-border/70 bg-background/60 px-3 py-2 text-xs"
                    >
                      <div className="flex items-center gap-1.5">
                        <MailIcon className="size-3.5 shrink-0 text-primary" />
                        <span className="font-medium text-foreground">
                          {MAIL_PROTOCOL_INFO[protocol].label}
                        </span>
                        <Badge
                          variant="secondary"
                          className="h-4 px-1.5 text-[10px]"
                        >
                          可用
                        </Badge>
                      </div>
                      <span className="text-muted-foreground">
                        {MAIL_PROTOCOL_INFO[protocol].hint}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="border border-border/70 bg-background/60 px-3 py-2 text-xs text-muted-foreground">
                  未标注取件协议，默认可尝试 IMAP 方式取件。
                </p>
              )}
            </section>

            <Alert variant="destructive">
              <TriangleAlertIcon />
              <AlertTitle>
                数据将在 {redeemRetentionHours} 小时后自动删除
              </AlertTitle>
              <AlertDescription>
                <div className="flex flex-col gap-1">
                  {redeemExpiresAt ? (
                    <span className="flex items-center gap-1.5">
                      <ClockIcon className="size-3.5 shrink-0" />
                      删除时间：{formatDateTime(redeemExpiresAt)}
                    </span>
                  ) : null}
                  <span>
                    到期后在线访问与订单查询将关闭，届时取件需自行导入账号数据。请立即下载或复制保存。
                  </span>
                </div>
              </AlertDescription>
            </Alert>
          </div>
          <DialogFooter className="border-t border-border/70 px-5 py-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => setRedeemReminderOpen(false)}
            >
              稍后手动保存
            </Button>
            <Button type="button" onClick={handleReminderDownload}>
              <DownloadIcon data-icon="inline-start" />
              立即下载 TXT
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </main>
  )
}
