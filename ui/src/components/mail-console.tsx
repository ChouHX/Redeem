import { useEffect, useMemo, useState, type FormEvent } from "react"
import {
  ArrowLeftIcon,
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  InboxIcon,
  Loader2Icon,
  MailIcon,
  MenuIcon,
  MoreVerticalIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react"

import {
  accessMailboxByCode,
  fetchPublicAds,
  fetchTempMailboxMessages,
  type AdSlotConfig,
  type MailFolder,
  type MailListResult,
  type MailMessage,
  type MailProtocol,
  type RedeemedItem,
  type TempMailAccount,
} from "@/lib/api"
import { copyTextToClipboard, formatDateTime, formatErrorMessage, notify } from "@/lib/shared"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { AdSlotCard } from "@/components/ad-slot-card"
import {
  Card,
  CardContent,
  CardHeader,
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Field, FieldContent, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { ThemeToggle } from "@/components/theme-toggle"
import { cn } from "@/lib/utils"

type MailAccount = TempMailAccount & {
  id: string
  label: string
  raw_line: string
  source: "code" | "manual"
  allowed_protocols?: MailProtocol[]
}

type FetchState = {
  accountId: string
  email: string
  protocol: MailProtocol
  loading: boolean
  error: string
  result: MailListResult | null
}

type ResultMessage = {
  key: string
  accountId: string
  email: string
  protocol: MailProtocol
  message: MailMessage
}

const LOCAL_ACCOUNTS_STORAGE_KEY = "redeem-mail-local-accounts"
const MAIL_PAGE_SIZE = 10
const FETCH_PAGE_SIZE = 100
const MAIL_PROTOCOLS: MailProtocol[] = ["imap", "graph"]

function createAccountId(email: string, refreshToken: string) {
  return `${email.toLowerCase()}::${refreshToken.slice(0, 16)}`
}

function normalizeProtocol(value: unknown): MailProtocol {
  return String(value || "").trim().toLowerCase() === "graph" ? "graph" : "imap"
}

function normalizeProtocolList(value: unknown, fallback: MailProtocol[] = ["imap"]) {
  const values = Array.isArray(value) ? value : []
  const protocols = values
    .map(normalizeProtocol)
    .filter((protocol, index, list) => list.indexOf(protocol) === index)

  return protocols.length ? protocols : fallback
}

function getAccountProtocols(account: MailAccount | null | undefined) {
  if (!account) {
    return MAIL_PROTOCOLS
  }

  if (account.source === "code") {
    return normalizeProtocolList(account.allowed_protocols, [
      normalizeProtocol(account.mail_protocol),
    ])
  }

  return MAIL_PROTOCOLS
}

function readLocalAccounts(): MailAccount[] {
  if (typeof window === "undefined") {
    return []
  }

  try {
    const parsed = JSON.parse(localStorage.getItem(LOCAL_ACCOUNTS_STORAGE_KEY) || "[]")
    if (!Array.isArray(parsed)) {
      return []
    }

    return (parsed as MailAccount[]).map((account): MailAccount => ({
      ...account,
      id: createAccountId(account.email, account.refresh_token),
      mail_protocol: normalizeProtocol(account.mail_protocol),
      allowed_protocols: MAIL_PROTOCOLS,
      source: "manual",
    }))
  } catch {
    return []
  }
}

function saveLocalAccounts(accounts: MailAccount[]) {
  if (typeof window === "undefined") {
    return
  }

  localStorage.setItem(
    LOCAL_ACCOUNTS_STORAGE_KEY,
    JSON.stringify(accounts.filter((account) => account.source === "manual"))
  )
}

function mergeAccounts(current: MailAccount[], incoming: MailAccount[]) {
  const byId = new Map(current.map((account) => [account.id, account]))
  for (const account of incoming) {
    byId.set(account.id, account)
  }
  return [...byId.values()]
}

function parseAccountLine(
  rawText: string,
  protocols: MailProtocol[],
  source: MailAccount["source"]
): MailAccount | null {
  const text = String(rawText || "").trim()
  if (!text.includes("----")) {
    return null
  }

  const parts = text.split("----").map((item) => item.trim())
  if (parts.length < 4) {
    return null
  }

  const email = parts[0] || ""
  const password = parts[1] || ""
  const clientId = parts[2] || ""
  const refreshToken = parts.slice(3).join("----")

  if (!email || !clientId || !refreshToken) {
    return null
  }

  const allowedProtocols = normalizeProtocolList(protocols)

  return {
    id: createAccountId(email, refreshToken),
    email,
    password,
    client_id: clientId,
    refresh_token: refreshToken,
    mail_protocol: allowedProtocols[0],
    allowed_protocols: allowedProtocols,
    raw_line: text,
    label: email,
    source,
  }
}

function accountFromRedeemedItem(item: RedeemedItem, index: number): MailAccount | null {
  const protocols = normalizeProtocolList(
    item.mail_protocols,
    normalizeProtocolList(item.type.mail_protocols, [
      normalizeProtocol(item.type.mail_protocol),
    ])
  )
  const rawLine = String(item.payload.raw_line || item.formatted_line || "").trim()
  const parsed = parseAccountLine(rawLine, protocols, "code")
  if (parsed) {
    return {
      ...parsed,
      label: item.type.name || `账号 ${index + 1}`,
    }
  }

  const email = String(
    item.payload.account ||
      item.payload.email ||
      item.payload.mail ||
      item.payload.username ||
      ""
  ).trim()
  const refreshToken = String(item.payload.refreshtoken || item.payload.refresh_token || "").trim()

  if (!email || !refreshToken) {
    return null
  }

  return {
    id: createAccountId(email, refreshToken),
    email,
    password: String(item.payload.password || item.payload.pass || ""),
    client_id: String(item.payload.oauth2id || item.payload.client_id || ""),
    refresh_token: refreshToken,
    mail_protocol: protocols[0],
    allowed_protocols: protocols,
    raw_line: rawLine,
    label: item.type.name || `账号 ${index + 1}`,
    source: "code",
  }
}

function resolveAddress(message?: MailMessage | null) {
  const address = message?.sender?.emailAddress || message?.from?.emailAddress
  return address?.name || address?.address || "未知发件人"
}

function isHtmlMailBody(message: MailMessage | null) {
  return (
    Boolean(message?.body?.content) &&
    String(message?.body?.contentType || "").toLowerCase() === "html"
  )
}

function renderBody(message: MailMessage | null) {
  const body = message?.body
  if (!body?.content) {
    return <div className="text-sm text-muted-foreground">暂无正文内容。</div>
  }

  if (isHtmlMailBody(message)) {
    return (
      <iframe
        title="邮件正文"
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        srcDoc={body.content}
        className="h-full w-full border-0 bg-background"
      />
    )
  }

  return (
    <pre className="m-0 whitespace-pre-wrap break-words text-sm leading-7">
      {body.content}
    </pre>
  )
}

function protocolLabel(protocol: MailProtocol) {
  return protocol === "graph" ? "Graph" : "IMAP"
}

export function MailConsole() {
  const [redeemCode, setRedeemCode] = useState("")
  const [accountQuery, setAccountQuery] = useState("")
  const [accountsCollapsed, setAccountsCollapsed] = useState(false)
  const [mailboxSheetOpen, setMailboxSheetOpen] = useState(false)
  const [importDialogOpen, setImportDialogOpen] = useState(false)
  const [importMode, setImportMode] = useState<"code" | "manual">("manual")
  const [manualText, setManualText] = useState("")
  const [accounts, setAccounts] = useState<MailAccount[]>([])
  const [selectedAccountId, setSelectedAccountId] = useState("")
  const [enabledProtocols, setEnabledProtocols] = useState<MailProtocol[]>(["imap"])
  const [folder, setFolder] = useState<MailFolder>("inbox")
  const [resultPage, setResultPage] = useState(1)
  const [loadingAccounts, setLoadingAccounts] = useState(false)
  const [fetching, setFetching] = useState(false)
  const [fetchStates, setFetchStates] = useState<FetchState[]>([])
  const [detailDialogOpen, setDetailDialogOpen] = useState(false)
  const [detailContext, setDetailContext] = useState<ResultMessage | null>(null)
  const [mailDetail, setMailDetail] = useState<MailMessage | null>(null)
  const [adSlot, setAdSlot] = useState<AdSlotConfig | null>(null)
  const detailBodyIsHtml = isHtmlMailBody(mailDetail)

  const filteredAccounts = useMemo(() => {
    const query = accountQuery.trim().toLowerCase()
    if (!query) {
      return accounts
    }

    return accounts.filter((account) =>
      [
        account.email,
        account.label,
        account.mail_protocol,
        account.source === "manual" ? "本地" : "兑换码",
      ]
        .join(" ")
        .toLowerCase()
        .includes(query)
    )
  }, [accountQuery, accounts])
  const selectedAccount = useMemo(
    () => accounts.find((account) => account.id === selectedAccountId) || null,
    [accounts, selectedAccountId]
  )
  const currentMailboxLabel = selectedAccount?.email || "未选择邮箱"
  const currentMailboxText = selectedAccount?.email || ""
  const selectedAllowedProtocols = getAccountProtocols(selectedAccount)
  const selectedEnabledProtocols = enabledProtocols.filter((protocol) =>
    selectedAllowedProtocols.includes(protocol)
  )
  const resultMessages = useMemo(() => {
    const items: ResultMessage[] = []
    for (const state of fetchStates) {
      for (const message of state.result?.items || []) {
        items.push({
          key: `${state.accountId}-${state.protocol}-${message.id || items.length}`,
          accountId: state.accountId,
          email: state.email,
          protocol: state.protocol,
          message,
        })
      }
    }
    return items
  }, [fetchStates])
  const failedFetchStates = useMemo(() => {
    if (fetchStates.some((state) => state.result)) {
      return []
    }

    return fetchStates.filter((state) => state.error)
  }, [fetchStates])
  const totalResultPages = Math.max(1, Math.ceil(resultMessages.length / MAIL_PAGE_SIZE))
  const pagedMessages = resultMessages.slice(
    (resultPage - 1) * MAIL_PAGE_SIZE,
    resultPage * MAIL_PAGE_SIZE
  )
  useEffect(() => {
    const storedAccounts = readLocalAccounts()
    setAccounts(storedAccounts)
    setSelectedAccountId(storedAccounts[0]?.id || "")
  }, [])

  useEffect(() => {
    let cancelled = false

    fetchPublicAds()
      .then((config) => {
        if (!cancelled && config.enabled) {
          setAdSlot(config)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAdSlot(null)
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    setResultPage((page) => Math.min(Math.max(1, page), totalResultPages))
  }, [totalResultPages])

  useEffect(() => {
    setEnabledProtocols((current) => {
      const next = current.filter((protocol) =>
        selectedAllowedProtocols.includes(protocol)
      )

      return next.length ? next : [selectedAllowedProtocols[0] || "imap"]
    })
  }, [selectedAllowedProtocols.join("|")])

  function replaceAccounts(updater: (current: MailAccount[]) => MailAccount[]) {
    setAccounts((current) => {
      const next = updater(current)
      saveLocalAccounts(next)
      setSelectedAccountId((currentSelected) =>
        next.some((account) => account.id === currentSelected)
          ? currentSelected
          : next[0]?.id || ""
      )
      return next
    })
  }

  function deleteAccount(accountId: string) {
    replaceAccounts((current) => current.filter((account) => account.id !== accountId))
    setFetchStates((current) => current.filter((state) => state.accountId !== accountId))
  }

  function clearAccounts() {
    replaceAccounts(() => [])
    setFetchStates([])
  }

  function selectAccount(accountId: string) {
    setSelectedAccountId(accountId)
  }

  function toggleEnabledProtocol(protocol: MailProtocol) {
    if (!selectedAllowedProtocols.includes(protocol)) {
      return
    }

    setEnabledProtocols((current) => {
      const currentAllowed = current.filter((item) =>
        selectedAllowedProtocols.includes(item)
      )

      if (currentAllowed.includes(protocol)) {
        return currentAllowed.length > 1
          ? currentAllowed.filter((item) => item !== protocol)
          : currentAllowed
      }

      return [...currentAllowed, protocol]
    })
  }

  async function importByCode(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    const code = redeemCode.trim()
    if (!code) {
      notify("请输入兑换码", "兑换码不能为空。", "destructive")
      return
    }

    setLoadingAccounts(true)
    try {
      const firstPage = await accessMailboxByCode(code, {
        page: 1,
        page_size: 100,
      })
      const totalPages = Math.max(1, Math.ceil(firstPage.data.total / 100))
      const pages = [firstPage]

      if (totalPages > 1) {
        const nextPages = await Promise.all(
          Array.from({ length: totalPages - 1 }, (_, index) =>
            accessMailboxByCode(code, {
              page: index + 2,
              page_size: 100,
            })
          )
        )
        pages.push(...nextPages)
      }

      const nextAccounts = pages
        .flatMap((page) => page.data.items)
        .map((item, index) => accountFromRedeemedItem(item, index))
        .filter((item): item is MailAccount => Boolean(item))

      if (!nextAccounts.length) {
        notify("没有可取件账号", "该兑换码没有解析出邮箱 OAuth 数据。", "destructive")
        return
      }

      setAccounts((current) => mergeAccounts(current, nextAccounts))
      setSelectedAccountId(nextAccounts[0].id)
      setImportDialogOpen(false)
      notify("账号已载入", `已载入 ${nextAccounts.length} 个账号。`)
    } catch (error) {
      notify("账号载入失败", formatErrorMessage(error), "destructive")
    } finally {
      setLoadingAccounts(false)
    }
  }

  function importManualAccounts(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    const lines = manualText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)

    if (!lines.length) {
      notify("请输入账号数据", "请按一行一个账号粘贴数据。", "destructive")
      return
    }

    const parsedAccounts: MailAccount[] = []
    const invalidLines: number[] = []

    for (const [index, line] of lines.entries()) {
      const account = parseAccountLine(line, MAIL_PROTOCOLS, "manual")
      if (account) {
        parsedAccounts.push(account)
      } else {
        invalidLines.push(index + 1)
      }
    }

    if (!parsedAccounts.length) {
      notify(
        "导入失败",
        "只支持 用户名----密码----clientid----refreshtoken 格式。",
        "destructive"
      )
      return
    }

    setAccounts((current) => {
      const merged = mergeAccounts(current, parsedAccounts)
      saveLocalAccounts(merged)
      return merged
    })
    setSelectedAccountId(parsedAccounts[0].id)
    setManualText("")
    setImportDialogOpen(false)
    notify(
      "本地账号已保存",
      invalidLines.length
        ? `已保存 ${parsedAccounts.length} 个，跳过 ${invalidLines.length} 行格式错误数据。`
        : `已保存 ${parsedAccounts.length} 个账号到浏览器本地。`
    )
  }

  async function fetchAccount(account: MailAccount | null) {
    if (!account) {
      notify("请选择账号", "选择一个邮箱后再取件。", "destructive")
      return
    }

    const protocols = enabledProtocols.filter((protocol) =>
      getAccountProtocols(account).includes(protocol)
    )

    if (!protocols.length) {
      notify("请选择协议", "当前邮箱没有启用可用的取件协议。", "destructive")
      return
    }

    const initialStates = protocols.map((protocol): FetchState => ({
      accountId: account.id,
      email: account.email,
      protocol,
      loading: true,
      error: "",
      result: null,
    }))

    setFetching(true)
    setFetchStates(initialStates)
    setResultPage(1)

    const settled = await Promise.allSettled(
      protocols.map(async (protocol) => {
        const result = await fetchTempMailboxMessages(
          {
            ...account,
            mail_protocol: protocol,
          },
          {
            folder,
            page: 1,
            page_size: FETCH_PAGE_SIZE,
            include_bodies: true,
          }
        )

        return { protocol, result }
      })
    )

    const nextStates = settled.map((entry, index): FetchState => {
      const protocol = protocols[index]
      if (entry.status === "fulfilled") {
        return {
          accountId: account.id,
          email: account.email,
          protocol,
          loading: false,
          error: "",
          result: entry.value.result,
        }
      }

      return {
        accountId: account.id,
        email: account.email,
        protocol,
        loading: false,
        error: formatErrorMessage(entry.reason),
        result: null,
      }
    })

    setFetchStates(nextStates)
    setFetching(false)

    const successCount = nextStates.filter((state) => state.result).length
    const messageCount = nextStates.reduce(
      (total, state) => total + (state.result?.items.length || 0),
      0
    )

    if (successCount > 0) {
      notify(
        "取件成功",
        messageCount ? `已获取 ${messageCount} 封邮件。` : "取件成功，暂无邮件。"
      )
    } else {
      notify("取件失败", "所有已启用协议均获取失败。", "destructive")
    }
  }

  function openMessageDetail(item: ResultMessage) {
    setDetailContext(item)
    setMailDetail(item.message)
    setDetailDialogOpen(true)
  }

  function exportAccounts() {
    const lines = accounts.map((account) => account.raw_line || [
      account.email,
      account.password,
      account.client_id,
      account.refresh_token,
    ].join("----"))

    if (!lines.length) {
      notify("没有可导出账号", "请先导入账号。", "destructive")
      return
    }

    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = "mail-accounts.txt"
    link.click()
    URL.revokeObjectURL(url)
  }

  function copyCurrentMailboxes() {
    if (!currentMailboxText) {
      notify("没有可复制邮箱", "请先选择邮箱账号。", "destructive")
      return
    }

    void copyTextToClipboard(currentMailboxText, "邮箱")
  }

  function handleAccountSelect(accountId: string) {
    selectAccount(accountId)
    setMailboxSheetOpen(false)
  }

  return (
    <main className="page-shell page-shell-redeem relative min-h-svh overflow-hidden text-foreground">
      <div className="redeem-noise pointer-events-none absolute inset-0" />
      <div className="relative mx-auto flex min-h-svh w-full max-w-7xl flex-col px-3 py-3 md:px-4">
        <header className="mb-3 flex h-8 shrink-0 items-center justify-between">
          <div className="flex min-w-0 items-center gap-2">
            <MailIcon className="text-primary" />
            <span className="truncate text-sm font-semibold">邮箱取件</span>
            <Badge variant="secondary">{accounts.length}</Badge>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" asChild>
              <a href="/redeem">
                <ArrowLeftIcon data-icon="inline-start" />
                返回兑换页面
              </a>
            </Button>
            <Button variant="outline" size="sm" onClick={() => setImportDialogOpen(true)}>
              <UploadIcon data-icon="inline-start" />
              导入账号
            </Button>
            <ThemeToggle />
          </div>
        </header>

        {adSlot ? (
          <AdSlotCard
            title={adSlot.title}
            description={adSlot.description}
            imageUrl={adSlot.image_url}
            primaryAction={adSlot.primary_action}
            compact
            className="mb-3 shrink-0"
          />
        ) : null}

        <Sheet open={mailboxSheetOpen} onOpenChange={setMailboxSheetOpen}>
          <SheetContent side="left" className="w-[min(82vw,20rem)] p-0">
            <SheetHeader className="border-b border-border/70 px-3 py-3">
              <SheetTitle>邮箱列表</SheetTitle>
            </SheetHeader>
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="shrink-0 px-3 py-3">
                <div className="flex flex-col gap-2">
                  <Input
                    value={accountQuery}
                    onChange={(event) => setAccountQuery(event.target.value)}
                    placeholder="搜索邮箱"
                    className="h-8 text-xs"
                  />
                  <div className="grid grid-cols-2 gap-1.5">
                    <Button size="sm" onClick={() => setImportDialogOpen(true)}>
                      <PlusIcon data-icon="inline-start" />
                      批量导入
                    </Button>
                    <Button variant="outline" size="sm" onClick={exportAccounts}>
                      <DownloadIcon data-icon="inline-start" />
                      导出邮箱
                    </Button>
                  </div>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
                {filteredAccounts.length ? (
                  <div className="flex flex-col gap-1">
                    {filteredAccounts.map((account) => {
                      const checked = selectedAccountId === account.id
                      return (
                        <div
                          key={account.id}
                          role="button"
                          tabIndex={0}
                          onClick={() => handleAccountSelect(account.id)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault()
                              handleAccountSelect(account.id)
                            }
                          }}
                          className={cn(
                            "flex min-w-0 cursor-pointer items-center gap-2 border border-border/70 bg-background/60 px-2 py-1.5 transition-colors hover:bg-muted/60",
                            checked && "border-primary/50 bg-primary/10"
                          )}
                        >
                          <span
                            className={cn(
                              "flex size-4 shrink-0 items-center justify-center rounded-full border border-border bg-background",
                              checked && "border-primary"
                            )}
                          >
                            {checked ? (
                              <span className="size-2 rounded-full bg-primary" />
                            ) : null}
                          </span>
                          <div className="min-w-0 flex-1 truncate text-[11px] font-medium leading-4">
                            {account.email}
                          </div>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                onClick={(event) => event.stopPropagation()}
                                aria-label={`${account.email} 操作`}
                              >
                                <MoreVerticalIcon />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-44">
                              <DropdownMenuLabel className="truncate">
                                {account.email}
                              </DropdownMenuLabel>
                              <DropdownMenuSeparator />
                              <DropdownMenuGroup>
                                <DropdownMenuItem
                                  variant="destructive"
                                  onSelect={() => deleteAccount(account.id)}
                                >
                                  <Trash2Icon />
                                  删除账号
                                </DropdownMenuItem>
                              </DropdownMenuGroup>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <div className="flex h-full min-h-72 flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground">
                    <InboxIcon />
                    <p>还没有邮箱账号。</p>
                  </div>
                )}
              </div>
              <div className="shrink-0 border-t border-border/70 p-3">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  disabled={!accounts.length}
                  onClick={clearAccounts}
                >
                  <Trash2Icon data-icon="inline-start" />
                  清空全部
                </Button>
              </div>
            </div>
          </SheetContent>
        </Sheet>

        <section
          className={cn(
            "grid min-h-0 flex-1 gap-0 overflow-hidden transition-[grid-template-columns] duration-300 ease-out lg:gap-4",
            accountsCollapsed
              ? "lg:grid-cols-[3.25rem_minmax(0,1fr)]"
              : "lg:grid-cols-[18rem_minmax(0,1fr)]"
          )}
        >
          <Card className="hidden min-h-0 flex-col overflow-hidden border border-border/70 bg-card/97 p-0 lg:flex">
            {!accountsCollapsed ? (
              <>
                <div className="shrink-0 px-2 py-2">
                  <div className="flex flex-col gap-2">
                    <Input
                      value={accountQuery}
                      onChange={(event) => setAccountQuery(event.target.value)}
                      placeholder="搜索邮箱"
                      className="h-8 text-xs"
                    />
                    <div className="grid grid-cols-2 gap-1.5">
                      <Button size="sm" onClick={() => setImportDialogOpen(true)}>
                        <PlusIcon data-icon="inline-start" />
                        批量导入
                      </Button>
                      <Button variant="outline" size="sm" onClick={exportAccounts}>
                        <DownloadIcon data-icon="inline-start" />
                        导出邮箱
                      </Button>
                    </div>
                  </div>
                </div>

              </>
            ) : null}

            <CardContent className={cn("min-h-0 flex-1 overflow-y-auto", accountsCollapsed ? "p-1.5" : "p-2")}>
              {accountsCollapsed ? (
                <div className="flex flex-col items-center gap-1.5">
                  {filteredAccounts.map((account) => {
                    const checked = selectedAccountId === account.id
                    return (
                      <button
                        key={account.id}
                        type="button"
                        title={account.email}
                        onClick={() => selectAccount(account.id)}
                        aria-label={`选择 ${account.email}`}
                        className={cn(
                          "relative flex size-8 items-center justify-center border border-border/70 bg-background/70 text-xs font-semibold transition-colors",
                          checked && "border-primary/60 bg-primary/12 text-primary"
                        )}
                      >
                        {account.email.slice(0, 1).toUpperCase()}
                        {checked ? (
                          <span className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-primary" />
                        ) : null}
                      </button>
                    )
                  })}
                </div>
              ) : filteredAccounts.length ? (
                <div className="flex flex-col gap-1">
                  {filteredAccounts.map((account) => {
                    const checked = selectedAccountId === account.id
                    return (
                      <div
                        key={account.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => selectAccount(account.id)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault()
                            selectAccount(account.id)
                          }
                        }}
                        className={cn(
                          "flex min-w-0 cursor-pointer items-center gap-2 border border-border/70 bg-background/60 px-2 py-1.5 transition-colors hover:bg-muted/60",
                          checked && "border-primary/50 bg-primary/10"
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => selectAccount(account.id)}
                          aria-label="选择邮箱"
                          className={cn(
                            "flex size-4 shrink-0 items-center justify-center rounded-full border border-border bg-background",
                            checked && "border-primary"
                          )}
                        >
                          {checked ? (
                            <span className="size-2 rounded-full bg-primary" />
                          ) : null}
                        </button>

                        <>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[11px] font-medium leading-4">
                              {account.email}
                            </div>
                          </div>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                onClick={(event) => event.stopPropagation()}
                                aria-label={`${account.email} 操作`}
                              >
                                <MoreVerticalIcon />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-44">
                              <DropdownMenuLabel className="truncate">
                                {account.email}
                              </DropdownMenuLabel>
                              <DropdownMenuSeparator />
                              <DropdownMenuGroup>
                                <DropdownMenuItem
                                  variant="destructive"
                                  onSelect={() => deleteAccount(account.id)}
                                >
                                  <Trash2Icon />
                                  删除账号
                                </DropdownMenuItem>
                              </DropdownMenuGroup>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="flex h-full min-h-72 flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground">
                  <InboxIcon />
                  {!accountsCollapsed ? (
                    <>
                      <p>还没有邮箱账号。</p>
                      <Button variant="outline" size="sm" onClick={() => setImportDialogOpen(true)}>
                        <PlusIcon data-icon="inline-start" />
                        导入账号
                      </Button>
                    </>
                  ) : null}
                </div>
              )}
            </CardContent>

            {!accountsCollapsed ? (
              <div className="shrink-0 border-t border-border/70 p-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  disabled={!accounts.length}
                  onClick={clearAccounts}
                >
                  <Trash2Icon data-icon="inline-start" />
                  清空全部
                </Button>
              </div>
            ) : null}
          </Card>

          <section className="flex min-h-0 min-w-0 flex-col overflow-hidden">
            <Card className="w-full shrink-0 border border-border/70 bg-card/97">
              <CardContent className="px-2 py-0.5">
                <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="lg:hidden"
                      aria-label="打开邮箱列表"
                      onClick={() => setMailboxSheetOpen(true)}
                    >
                      <MenuIcon />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="hidden lg:inline-flex"
                      aria-label={accountsCollapsed ? "展开账号列表" : "折叠账号列表"}
                      onClick={() => setAccountsCollapsed((value) => !value)}
                    >
                      <MenuIcon />
                    </Button>
                    <div className="flex items-center gap-1.5">
                      {MAIL_PROTOCOLS.map((protocol) => {
                        const disabled = !selectedAllowedProtocols.includes(protocol)
                        const enabled = !disabled && enabledProtocols.includes(protocol)

                        return (
                          <button
                            key={protocol}
                            type="button"
                            disabled={disabled}
                            onClick={() => toggleEnabledProtocol(protocol)}
                            aria-pressed={enabled}
                            title={
                              disabled
                                ? `当前邮箱不支持 ${protocolLabel(protocol)}`
                                : `${enabled ? "停用" : "启用"} ${protocolLabel(protocol)}`
                            }
                          >
                            <Badge
                              variant={enabled ? "default" : "outline"}
                              className={cn(
                                "h-6 cursor-pointer gap-1 border px-2.5 text-xs transition-colors",
                                enabled && "border-primary bg-primary text-primary-foreground",
                                disabled && "cursor-not-allowed opacity-40"
                              )}
                            >
                              {enabled ? <CheckIcon /> : null}
                              {protocolLabel(protocol)}
                            </Badge>
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <Select
                      value={folder}
                      onValueChange={(value) =>
                        setFolder(value === "spam" ? "spam" : "inbox")
                      }
                    >
                      <SelectTrigger className="h-6 w-24 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="inbox">收件箱</SelectItem>
                          <SelectItem value="spam">垃圾箱</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <Button
                      size="xs"
                      disabled={fetching || !selectedAccount || !selectedEnabledProtocols.length}
                      onClick={() => {
                        if (selectedAccount) {
                          void fetchAccount(selectedAccount)
                        }
                      }}
                    >
                      {fetching ? (
                        <Loader2Icon data-icon="inline-start" className="animate-spin" />
                      ) : (
                        <DownloadIcon data-icon="inline-start" />
                      )}
                      取件
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="mt-2 gap-0 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border border-border/70 bg-card/97 ">
              <CardHeader className="flex shrink-0 flex-row items-center justify-between gap-2 border-b border-border/70">
                <div className="flex shrink-0 items-center gap-2">
                  <div className="flex items-center">
                    <span className="truncate">{currentMailboxLabel}</span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0"
                      disabled={!currentMailboxText}
                      onClick={copyCurrentMailboxes}
                      aria-label="复制邮箱"
                    >
                      <CopyIcon />
                    </Button>
                  </div>
                  <Badge variant="secondary">共 {resultMessages.length} 封</Badge>
                </div>
              </CardHeader>

              <CardContent className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-1.5">
                {fetching ? (
                  <div className="flex flex-col gap-1">
                    {Array.from({ length: 6 }).map((_, index) => (
                      <Skeleton key={index} className="h-11 w-full" />
                    ))}
                  </div>
                ) : pagedMessages.length || failedFetchStates.length ? (
                  <div className="min-w-0 overflow-hidden border border-border/70 bg-background/60">
                    {failedFetchStates.map((state) => (
                      <div
                        key={`${state.accountId}-${state.protocol}-error`}
                        className="min-w-0 border-b border-destructive/30 px-2 py-1 text-xs last:border-b-0"
                      >
                        <div className="truncate font-medium text-destructive">
                          {state.email} {protocolLabel(state.protocol)} 取件失败
                        </div>
                        <div className="mt-0.5 break-words text-[11px] text-muted-foreground">
                          {state.error}
                        </div>
                      </div>
                    ))}

                    {pagedMessages.map((item) => (
                      <article
                        key={item.key}
                        className="min-w-0 cursor-pointer border-b border-border/70 px-2 py-1 transition-colors last:border-b-0 hover:bg-muted/60"
                        role="button"
                        tabIndex={0}
                        onClick={() => void openMessageDetail(item)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault()
                            void openMessageDetail(item)
                          }
                        }}
                      >
                        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_5.25rem] items-center gap-x-2 gap-y-0.5 sm:grid-cols-[minmax(8rem,1fr)_minmax(10rem,1.6fr)_7rem] sm:gap-2">
                          <div className="order-3 col-span-2 min-w-0 sm:order-none sm:col-span-1">
                            <div className="flex min-w-0 items-center gap-1.5">
                              <span className="truncate text-[11px] font-medium text-muted-foreground">
                                {resolveAddress(item.message)}
                              </span>
                            </div>
                            <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                              {item.email}
                            </div>
                          </div>
                          <div className="order-1 min-w-0 sm:order-none">
                            <h2 className="truncate text-xs font-semibold">
                              {item.message.subject || "(无主题)"}
                            </h2>
                            {item.message.bodyPreview ? (
                              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                                {item.message.bodyPreview}
                              </p>
                            ) : null}
                          </div>
                          <time className="order-2 justify-self-end truncate text-[11px] text-muted-foreground sm:order-none">
                            {formatDateTime(item.message.receivedDateTime)}
                          </time>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="flex h-full min-h-96 flex-col items-center justify-center gap-3 border border-border/70 bg-background/60 text-center text-sm text-muted-foreground">
                    <InboxIcon />
                    <div>
                      <div className="font-medium text-foreground">暂无取件结果</div>
                      <div className="mt-1 text-xs">
                        选择协议 tag，选择邮箱后点击取件。
                      </div>
                    </div>
                  </div>
                )}
              </CardContent>
              <div className="flex shrink-0 items-center justify-end gap-1 border-t border-border/70 px-2 py-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={resultPage <= 1}
                  onClick={() => setResultPage((page) => Math.max(1, page - 1))}
                >
                  上一页
                </Button>
                <span className="min-w-14 text-center text-[11px] text-muted-foreground">
                  {resultPage}/{totalResultPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={resultPage >= totalResultPages}
                  onClick={() =>
                    setResultPage((page) => Math.min(totalResultPages, page + 1))
                  }
                >
                  下一页
                </Button>
              </div>
            </Card>
          </section>
        </section>

        <Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}>
          <DialogContent className="flex max-h-[min(92svh,34rem)] w-[min(96vw,42rem)] max-w-[min(96vw,42rem)] flex-col overflow-hidden p-0 sm:max-w-[min(96vw,42rem)]">
            <DialogHeader className="border-b border-border/70 px-5 py-4">
              <DialogTitle>账号导入</DialogTitle>
              <DialogDescription>
                通过同一个入口载入兑换码账号或临时账号；本地账号只保存到当前浏览器。
              </DialogDescription>
            </DialogHeader>
            <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-5 py-4">
              <Tabs
                value={importMode}
                onValueChange={(value) => setImportMode(value as "code" | "manual")}
                className="min-w-0"
              >
                <TabsList variant="line">
                  <TabsTrigger value="manual">临时账号</TabsTrigger>
                  <TabsTrigger value="code">兑换码账号</TabsTrigger>
                </TabsList>

                <TabsContent value="manual" className="min-w-0 pt-4">
                  <form className="flex flex-col gap-4" onSubmit={importManualAccounts}>
                    <Field>
                      <FieldLabel htmlFor="manual-accounts">临时账号数据</FieldLabel>
                      <FieldContent className="min-w-0">
                        <Textarea
                          id="manual-accounts"
                          value={manualText}
                          onChange={(event) => setManualText(event.target.value)}
                          rows={8}
                          placeholder="username@example.com----password----clientid----refreshtoken"
                          wrap="off"
                          spellCheck={false}
                          className="h-32 max-h-48 min-h-32 w-full max-w-full resize-y overflow-auto whitespace-pre font-mono leading-5 [field-sizing:fixed]"
                        />
                        <p className="text-xs text-muted-foreground">
                          只支持 用户名----密码----clientid----refreshtoken 格式，一行一个账号。
                        </p>
                      </FieldContent>
                    </Field>
                    <DialogFooter className="px-0">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setImportDialogOpen(false)}
                      >
                        取消
                      </Button>
                      <Button type="submit">保存到本地</Button>
                    </DialogFooter>
                  </form>
                </TabsContent>

                <TabsContent value="code" className="pt-4">
                  <form className="flex flex-col gap-4" onSubmit={importByCode}>
                    <Field>
                      <FieldLabel htmlFor="mail-code">兑换码</FieldLabel>
                      <FieldContent>
                        <Input
                          id="mail-code"
                          value={redeemCode}
                          onChange={(event) => setRedeemCode(event.target.value)}
                          placeholder="输入已兑换或待兑换卡密"
                        />
                      </FieldContent>
                    </Field>
                    <DialogFooter className="px-0">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setImportDialogOpen(false)}
                      >
                        取消
                      </Button>
                      <Button type="submit" disabled={loadingAccounts}>
                        {loadingAccounts ? (
                          <Loader2Icon data-icon="inline-start" className="animate-spin" />
                        ) : (
                          <SearchIcon data-icon="inline-start" />
                        )}
                        载入账号
                      </Button>
                    </DialogFooter>
                  </form>
                </TabsContent>
              </Tabs>
            </div>
          </DialogContent>
        </Dialog>

        <Dialog open={detailDialogOpen} onOpenChange={setDetailDialogOpen}>
          <DialogContent className="flex h-[min(92svh,42rem)] max-h-[min(92svh,42rem)] w-[min(96vw,54rem)] max-w-[min(96vw,54rem)] flex-col overflow-hidden p-0 sm:max-w-[min(96vw,54rem)]">
            <DialogHeader className="border-b border-border/70 px-6 py-4">
              <DialogTitle className="line-clamp-2 pr-6 text-base">
                {mailDetail?.subject || detailContext?.message.subject || "(无主题)"}
              </DialogTitle>
              <DialogDescription className="flex flex-wrap items-center gap-x-4 gap-y-1 pr-6">
                {detailContext
                  ? (
                      <>
                        <span className="min-w-0 truncate">
                          发件人：{resolveAddress(mailDetail || detailContext.message)}
                        </span>
                        <span>
                          时间：{formatDateTime(
                            mailDetail?.receivedDateTime ||
                              detailContext.message.receivedDateTime
                          )}
                        </span>
                        <span className="min-w-0 truncate">
                          收件账号：{detailContext.email}
                        </span>
                        <span>{folder === "spam" ? "垃圾箱" : "收件箱"}</span>
                      </>
                    )
                  : "邮件详情"}
              </DialogDescription>
            </DialogHeader>
            <div
              className={cn(
                "min-h-0 flex-1",
                detailBodyIsHtml
                  ? "overflow-hidden px-0 py-0"
                  : "overflow-y-auto px-6 py-5"
              )}
            >
              <div
                className={cn(
                  "min-h-0 bg-background/40",
                  detailBodyIsHtml && "h-full"
                )}
              >
                {renderBody(mailDetail)}
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </main>
  )
}
