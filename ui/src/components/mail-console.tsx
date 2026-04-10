import { useEffect, useMemo, useRef, useState } from "react"
import {
  CopyIcon,
  EllipsisVerticalIcon,
  EyeIcon,
  InfoIcon,
  KeyRoundIcon,
  LayoutPanelLeftIcon,
  RefreshCcwIcon,
  UserRoundPlusIcon,
} from "lucide-react"

import {
  accessMailboxByCode,
  type AdSlotConfig,
  ApiError,
  type MailAddress,
  type MailFolder,
  type MailListResult,
  type MailMessage,
  type MailMessageSummary,
  type RedeemAccessResult,
  type RedeemedItem,
  type TempMailAccount,
  fetchPublicAds,
  fetchMailboxMessageDetail,
  fetchMailboxMessages,
  fetchTempMailboxMessageDetail,
  fetchTempMailboxMessages,
} from "@/lib/api"
import { AdSlotCard } from "@/components/ad-slot-card"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardDescription,
  CardContent,
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Field,
  FieldContent,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ThemeToggle } from "@/components/theme-toggle"
import { cn } from "@/lib/utils"
import { toast } from "sonner"

type TempAccountFormState = {
  email: string
  password: string
  refreshToken: string
}

type MailboxEntry = {
  id: string
  email: string
  password: string
  clientId: string
  refreshToken: string
  rawLine: string
  sourceType: "redeem" | "temp"
  sourceLabel: string
  item?: RedeemedItem
}

type FolderMailLists = Record<MailFolder, MailListResult | null>
type FolderLoadingState = Record<MailFolder, boolean>
type FolderSelectionState = Record<MailFolder, string>
type RedeemMailboxPageState = {
  items: MailboxEntry[]
  total: number
  page: number
  page_size: number
}

const TEMP_ACCOUNT_STORAGE_KEY = "tempAccount"
const DEFAULT_PAGE_SIZE = 10
const EMPTY_MAIL_LISTS: FolderMailLists = {
  inbox: null,
  spam: null,
}
const EMPTY_FOLDER_LOADING: FolderLoadingState = {
  inbox: false,
  spam: false,
}
const EMPTY_FOLDER_SELECTION: FolderSelectionState = {
  inbox: "",
  spam: "",
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

function parseAccountLine(rawText: string) {
  const text = String(rawText || "").trim()
  if (!text.includes("----")) {
    return null
  }

  const parts = text.split("----").map((item) => item.trim())
  if (parts.length >= 4) {
    return {
      email: parts[0],
      password: parts[1],
      client_id: parts[2],
      refresh_token: parts.slice(3).join("----"),
    }
  }

  if (parts.length >= 2) {
    return {
      email: parts[0],
      password: "",
      client_id: "",
      refresh_token: parts.slice(1).join("----"),
    }
  }

  return null
}

function parseEmailFromRedeemedItem(item: RedeemedItem) {
  if (item.payload.raw_line) {
    return String(item.payload.raw_line).split("----")[0]?.trim() || ""
  }

  return String(
    item.payload.account ||
      item.payload.email ||
      item.payload.mail ||
      item.payload.username ||
      ""
  ).trim()
}

function createTempMailboxEntry(account: TempMailAccount): MailboxEntry {
  return {
    id: `temp-${account.email}`,
    email: account.email,
    password: account.password,
    clientId: account.client_id,
    refreshToken: account.refresh_token,
    rawLine: [
      account.email,
      account.password || "",
      account.client_id || "",
      account.refresh_token || "",
    ].join("----"),
    sourceType: "temp",
    sourceLabel: "临时账户",
  }
}

function createRedeemMailboxEntry(
  item: RedeemedItem,
  index: number
): MailboxEntry | null {
  const parsed = parseAccountLine(
    String(item.payload.raw_line || item.formatted_line || "")
  )
  const email = parsed?.email || parseEmailFromRedeemedItem(item)
  if (!email) {
    return null
  }

  return {
    id: `redeem-${index}-${email}`,
    email,
    password:
      parsed?.password || String(item.payload.password || item.payload.pass || ""),
    clientId:
      parsed?.client_id ||
      String(item.payload.oauth2id || item.payload.client_id || ""),
    refreshToken:
      parsed?.refresh_token ||
      String(item.payload.refreshtoken || item.payload.refresh_token || ""),
    rawLine: String(item.payload.raw_line || item.formatted_line || "").trim(),
    sourceType: "redeem",
    sourceLabel: item.type.name || "兑换结果",
    item,
  }
}

function buildMailboxCollection(
  redeemMailboxes: MailboxEntry[],
  tempAccount: TempMailAccount | null
) {
  const map = new Map<string, MailboxEntry>()

  if (tempAccount?.email) {
    const tempEntry = createTempMailboxEntry(tempAccount)
    map.set(tempEntry.email.toLowerCase(), tempEntry)
  }

  for (const mailbox of redeemMailboxes) {
    const key = mailbox.email.toLowerCase()
    if (!map.has(key)) {
      map.set(key, mailbox)
    }
  }

  return Array.from(map.values())
}

function mergeMailboxEntries(
  current: MailboxEntry[],
  next: MailboxEntry[]
) {
  const map = new Map<string, MailboxEntry>()

  for (const mailbox of current) {
    map.set(mailbox.email.toLowerCase(), mailbox)
  }

  for (const mailbox of next) {
    map.set(mailbox.email.toLowerCase(), mailbox)
  }

  return Array.from(map.values())
}

function formatFolderLabel(folder: MailFolder) {
  return folder === "spam" ? "垃圾箱" : "收件箱"
}

function formatMailDate(value: string | undefined) {
  if (!value) {
    return "未知时间"
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }

  const now = new Date()
  const dayMs = 24 * 60 * 60 * 1000
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  )
  const startOfTarget = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate()
  )
  const diffDays = Math.round(
    (startOfToday.getTime() - startOfTarget.getTime()) / dayMs
  )

  if (diffDays === 0) {
    return `今天 ${date.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    })}`
  }

  if (diffDays === 1) {
    return `昨天 ${date.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    })}`
  }

  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function formatDetailMailDate(value: string | undefined) {
  if (!value) {
    return "未知时间"
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }

  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function sanitizeStyleContent(value: string) {
  return String(value || "")
    .replace(/@import[\s\S]*?;/gi, "")
    .replace(/expression\s*\([^)]*\)/gi, "")
    .replace(/url\s*\(\s*['"]?\s*javascript:[^)]*\)/gi, "url()")
}

function sanitizeHtml(html: string) {
  const parser = new DOMParser()
  const doc = parser.parseFromString(String(html || ""), "text/html")

  doc
    .querySelectorAll(
      "script, iframe, object, embed, link, meta, base, form"
    )
    .forEach((node) => {
      node.remove()
    })

  const styleBlocks = Array.from(doc.querySelectorAll("style")).map((node) => {
    const nextStyle = doc.createElement("style")
    nextStyle.textContent = sanitizeStyleContent(node.textContent || "")
    node.remove()
    return nextStyle.outerHTML
  })

  doc.querySelectorAll("*").forEach((element) => {
    Array.from(element.attributes).forEach((attribute) => {
      const name = attribute.name.toLowerCase()
      const value = attribute.value || ""

      if (name.startsWith("on")) {
        element.removeAttribute(attribute.name)
        return
      }

      const isUrlAttribute = [
        "href",
        "src",
        "xlink:href",
        "action",
        "formaction",
      ].includes(name)
      if (isUrlAttribute && /^\s*javascript:/i.test(value)) {
        element.removeAttribute(attribute.name)
        return
      }

      if (
        name === "style" &&
        /(expression\s*\(|url\s*\(\s*['"]?\s*javascript:)/i.test(value)
      ) {
        element.removeAttribute(attribute.name)
      }
    })
  })

  return `${styleBlocks.join("\n")}${doc.body.innerHTML}`
}

function MailHtmlContent({ html }: { html: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const shadowRootRef = useRef<ShadowRoot | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) {
      return
    }

    if (!shadowRootRef.current) {
      shadowRootRef.current = host.attachShadow({ mode: "open" })
    }

    const shadowRoot = shadowRootRef.current
    shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          color: var(--foreground);
        }

        .mail-html-root {
          min-height: 100%;
          color: inherit;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .mail-html-root,
        .mail-html-root * {
          box-sizing: border-box;
        }

        .mail-html-root img,
        .mail-html-root table,
        .mail-html-root iframe,
        .mail-html-root video {
          max-width: 100%;
        }

        .mail-html-root img {
          height: auto;
        }

        .mail-html-root pre {
          white-space: pre-wrap;
        }
      </style>
      <div class="mail-html-root">${html || "<div>(无内容)</div>"}</div>
    `
  }, [html])

  return <div ref={hostRef} className="mail-html-host" />
}

function resolveMailAddress(address?: MailAddress) {
  if (!address) {
    return { name: "未知发件人", address: "" }
  }

  return {
    name: address.name || address.address || "未知发件人",
    address: address.address || "",
  }
}

function mailboxToTempAccount(mailbox: MailboxEntry): TempMailAccount {
  return {
    email: mailbox.email,
    password: mailbox.password,
    client_id: mailbox.clientId,
    refresh_token: mailbox.refreshToken,
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

function InfoHint({ description }: { description: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon-xs"
          aria-label="查看页面说明"
        >
          <InfoIcon />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" sideOffset={8}>
        <p className="max-w-72 leading-5">{description}</p>
      </TooltipContent>
    </Tooltip>
  )
}

export function MailConsole() {
  const [adSlot, setAdSlot] = useState<AdSlotConfig | null>(null)
  const [code, setCode] = useState("")
  const [activeFolder, setActiveFolder] = useState<MailFolder>("inbox")
  const [currentEmail, setCurrentEmail] = useState("")
  const [mailLists, setMailLists] = useState<FolderMailLists>(EMPTY_MAIL_LISTS)
  const [folderLoading, setFolderLoading] =
    useState<FolderLoadingState>(EMPTY_FOLDER_LOADING)
  const [selectedMessageIds, setSelectedMessageIds] =
    useState<FolderSelectionState>(EMPTY_FOLDER_SELECTION)
  const [messageDetail, setMessageDetail] = useState<MailMessage | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [codeDialogOpen, setCodeDialogOpen] = useState(false)
  const [sidebarSheetOpen, setSidebarSheetOpen] = useState(false)
  const [accountsDialogOpen, setAccountsDialogOpen] = useState(false)
  const [accountDetailOpen, setAccountDetailOpen] = useState(false)
  const [accountDetail, setAccountDetail] = useState<MailboxEntry | null>(null)
  const [tempDialogOpen, setTempDialogOpen] = useState(false)
  const [tempAccount, setTempAccount] = useState<TempMailAccount | null>(null)
  const [tempAccountForm, setTempAccountForm] = useState<TempAccountFormState>({
    email: "",
    password: "",
    refreshToken: "",
  })
  const [redeemMailboxes, setRedeemMailboxes] = useState<MailboxEntry[]>([])
  const [redeemAccess, setRedeemAccess] = useState<Pick<
    RedeemAccessResult,
    "code" | "source" | "redeemed_at"
  > | null>(null)
  const [redeemMailboxPage, setRedeemMailboxPage] =
    useState<RedeemMailboxPageState | null>(null)
  const [accountsLoading, setAccountsLoading] = useState(false)
  const [codeLoading, setCodeLoading] = useState(false)
  const sidebarScrollRefs = useRef<Record<MailFolder, HTMLDivElement | null>>({
    inbox: null,
    spam: null,
  })

  useEffect(() => {
    const stored = sessionStorage.getItem(TEMP_ACCOUNT_STORAGE_KEY)
    if (!stored) {
      return
    }

    try {
      const parsed = JSON.parse(stored) as TempMailAccount
      setTempAccount(parsed)
      setTempAccountForm({
        email: parsed.email,
        password: parsed.password,
        refreshToken: parsed.refresh_token,
      })
    } catch {
      sessionStorage.removeItem(TEMP_ACCOUNT_STORAGE_KEY)
    }
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

  const mailboxes = useMemo(
    () => buildMailboxCollection(redeemMailboxes, tempAccount),
    [redeemMailboxes, tempAccount]
  )
  const accountListMailboxes = useMemo(() => {
    const visible: MailboxEntry[] = []
    const seen = new Set<string>()

    if (tempAccount?.email) {
      const tempEntry = createTempMailboxEntry(tempAccount)
      visible.push(tempEntry)
      seen.add(tempEntry.email.toLowerCase())
    }

    for (const mailbox of redeemMailboxPage?.items || []) {
      const key = mailbox.email.toLowerCase()
      if (seen.has(key)) {
        continue
      }
      visible.push(mailbox)
      seen.add(key)
    }

    return visible
  }, [redeemMailboxPage, tempAccount])
  const accountListPageCount = Math.max(
    Math.ceil(
      (redeemMailboxPage?.total || 0) /
        (redeemMailboxPage?.page_size || DEFAULT_PAGE_SIZE)
    ),
    1
  )

  const selectedMailbox = useMemo(
    () => mailboxes.find((item) => item.email === currentEmail) || null,
    [mailboxes, currentEmail]
  )

  const activeFolderLoading = folderLoading[activeFolder]
  const sender = useMemo(() => {
    return resolveMailAddress(
      messageDetail?.sender?.emailAddress || messageDetail?.from?.emailAddress
    )
  }, [messageDetail])
  const recipients = useMemo(() => {
    return (
      messageDetail?.toRecipients
        ?.map((item) => item.emailAddress?.name || item.emailAddress?.address)
        .filter(Boolean)
        .join("，") || "未知收件人"
    )
  }, [messageDetail])
  const bodyContent = messageDetail?.body?.content || ""
  const contentType = messageDetail?.body?.contentType || "text"
  const isHtmlContent =
    contentType === "html" || /<(html|body|div|p|table)/i.test(bodyContent)
  const sanitizedBody = useMemo(
    () => (isHtmlContent ? sanitizeHtml(bodyContent) : ""),
    [bodyContent, isHtmlContent]
  )

  useEffect(() => {
    if (!mailboxes.length) {
      setCurrentEmail("")
      return
    }

    if (!mailboxes.some((mailbox) => mailbox.email === currentEmail)) {
      setCurrentEmail(mailboxes[0].email)
    }
  }, [mailboxes, currentEmail])

  async function handleCopy(value: string, label: string) {
    if (!value) {
      return
    }

    try {
      await navigator.clipboard.writeText(value)
      notify("复制成功", `${label} 已复制到剪贴板`)
    } catch {
      notify(
        "复制失败",
        "当前环境不支持自动复制，请手动复制。",
        "destructive"
      )
    }
  }

  function resetRedeemMailboxAccess() {
    setRedeemAccess(null)
    setRedeemMailboxPage(null)
    setRedeemMailboxes([])
  }

  function resetMailboxView(nextFolder: MailFolder = "inbox") {
    setActiveFolder(nextFolder)
    setMailLists(EMPTY_MAIL_LISTS)
    setSelectedMessageIds(EMPTY_FOLDER_SELECTION)
    setMessageDetail(null)
  }

  async function openMessageDetailForMailbox(
    mailbox: MailboxEntry,
    message: MailMessageSummary,
    folder: MailFolder
  ) {
    if (!message.id) {
      return
    }

    setDetailLoading(true)
    setSelectedMessageIds((current) => ({
      ...current,
      [folder]: message.id || "",
    }))

    try {
      const result =
        mailbox.sourceType === "temp"
          ? await fetchTempMailboxMessageDetail(
              mailboxToTempAccount(mailbox),
              message.id,
              folder
            )
          : await fetchMailboxMessageDetail(mailbox.email, message.id, folder)

      setMessageDetail(result.item)
      setSidebarSheetOpen(false)
    } catch (error) {
      notify("详情获取失败", formatErrorMessage(error), "destructive")
    } finally {
      setDetailLoading(false)
    }
  }

  async function loadFolderMessages(
    mailbox: MailboxEntry,
    folder: MailFolder,
    {
      page = 1,
      pageSize = DEFAULT_PAGE_SIZE,
      preserveSelection = true,
    }: {
      page?: number
      pageSize?: number
      preserveSelection?: boolean
    } = {}
  ) {
    setFolderLoading((current) => ({ ...current, [folder]: true }))
    setCurrentEmail(mailbox.email)
    setActiveFolder(folder)

    try {
      const result =
        mailbox.sourceType === "temp"
          ? await fetchTempMailboxMessages(mailboxToTempAccount(mailbox), {
              folder,
              page,
              page_size: pageSize,
            })
          : await fetchMailboxMessages(mailbox.email, {
              folder,
              page,
              page_size: pageSize,
            })

      setMailLists((current) => ({
        ...current,
        [folder]: result,
      }))
      requestAnimationFrame(() => {
        sidebarScrollRefs.current[folder]?.scrollTo({ top: 0 })
      })

      const nextMessage =
        (preserveSelection
          ? result.items.find(
              (item) => item.id && item.id === selectedMessageIds[folder]
            )
          : null) ||
        result.items[0] ||
        null

      if (nextMessage) {
        await openMessageDetailForMailbox(mailbox, nextMessage, folder)
      } else {
        setSelectedMessageIds((current) => ({ ...current, [folder]: "" }))
        setMessageDetail(null)
      }

      return result
    } catch (error) {
      setMailLists((current) => ({ ...current, [folder]: null }))
      setSelectedMessageIds((current) => ({ ...current, [folder]: "" }))
      setMessageDetail(null)
      notify("获取失败", formatErrorMessage(error), "destructive")
      return null
    } finally {
      setFolderLoading((current) => ({ ...current, [folder]: false }))
    }
  }

  async function activateMailbox(
    mailbox: MailboxEntry,
    folder: MailFolder = "inbox"
  ) {
    resetMailboxView(folder)
    setCurrentEmail(mailbox.email)
    return loadFolderMessages(mailbox, folder, {
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
      preserveSelection: false,
    })
  }

  async function handleFolderChange(folder: MailFolder) {
    setActiveFolder(folder)

    if (!selectedMailbox) {
      return
    }

    const targetList = mailLists[folder]
    if (!targetList) {
      await loadFolderMessages(selectedMailbox, folder, {
        page: 1,
        pageSize: DEFAULT_PAGE_SIZE,
      })
      return
    }

    const selectedSummary =
      targetList.items.find((item) => item.id === selectedMessageIds[folder]) ||
      targetList.items[0] ||
      null

    if (!selectedSummary) {
      setMessageDetail(null)
      return
    }

    if (
      messageDetail?.id !== selectedSummary.id ||
      messageDetail?.folder !== folder
    ) {
      await openMessageDetailForMailbox(selectedMailbox, selectedSummary, folder)
    }
  }

  async function handleRefreshCurrentFolder() {
    if (!selectedMailbox) {
      notify(
        "请选择邮箱",
        "请先载入兑换码或启用临时账户。",
        "destructive"
      )
      return
    }

    const currentList = mailLists[activeFolder]
    await loadFolderMessages(selectedMailbox, activeFolder, {
      page: currentList?.page || 1,
      pageSize: DEFAULT_PAGE_SIZE,
    })
  }

  async function handleFolderPageChange(folder: MailFolder, page: number) {
    if (!selectedMailbox) {
      return
    }

    await loadFolderMessages(selectedMailbox, folder, {
      page,
      pageSize: DEFAULT_PAGE_SIZE,
      preserveSelection: false,
    })
  }

  async function loadRedeemMailboxPage(
    codeValue: string,
    {
      page = 1,
      replaceCache = false,
      activateFirst = false,
      resetOnError = false,
      openDialog = false,
    }: {
      page?: number
      replaceCache?: boolean
      activateFirst?: boolean
      resetOnError?: boolean
      openDialog?: boolean
    } = {}
  ) {
    setAccountsLoading(true)

    try {
      const payload = await accessMailboxByCode(codeValue, {
        page,
        page_size: DEFAULT_PAGE_SIZE,
      })
      const nextMailboxes = payload.data.items
        .map((item, index) =>
          createRedeemMailboxEntry(
            item,
            (payload.data.page - 1) * payload.data.page_size + index
          )
        )
        .filter((item): item is MailboxEntry => Boolean(item))

      setRedeemAccess({
        code: payload.data.code,
        source: payload.data.source,
        redeemed_at: payload.data.redeemed_at,
      })
      setRedeemMailboxPage({
        items: nextMailboxes,
        total: payload.data.total,
        page: payload.data.page,
        page_size: payload.data.page_size,
      })
      setRedeemMailboxes((current) =>
        replaceCache ? nextMailboxes : mergeMailboxEntries(current, nextMailboxes)
      )

      if (openDialog) {
        setAccountsDialogOpen(true)
      }

      if (activateFirst) {
        const initialMailbox =
          nextMailboxes[0] ||
          (tempAccount?.email ? createTempMailboxEntry(tempAccount) : null)

        if (initialMailbox) {
          void activateMailbox(initialMailbox, "inbox")
        } else {
          resetMailboxView("inbox")
        }
      }

      return payload.data
    } catch (error) {
      if (resetOnError) {
        resetRedeemMailboxAccess()
        resetMailboxView("inbox")
      }
      notify(
        resetOnError ? "兑换码无效" : "账户列表加载失败",
        formatErrorMessage(error),
        "destructive"
      )
      return null
    } finally {
      setAccountsLoading(false)
    }
  }

  async function loadMailboxesByCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextCode = code.trim()
    if (!nextCode) {
      notify("请输入兑换码", "兑换码不能为空。", "destructive")
      return
    }

    setCodeLoading(true)

    try {
      setCodeDialogOpen(false)
      const payload = await loadRedeemMailboxPage(nextCode, {
        page: 1,
        replaceCache: true,
        activateFirst: true,
        resetOnError: true,
        openDialog: true,
      })
      if (!payload) {
        return
      }

      notify(
        "邮箱已载入",
        payload.source === "newly_redeemed"
          ? "兑换码已自动兑换，账户列表可在弹窗中查看。"
          : "已载入兑换码对应的邮箱列表。"
      )
    } finally {
      setCodeLoading(false)
    }
  }

  async function handleRedeemMailboxPageChange(page: number) {
    if (!redeemAccess?.code || accountsLoading) {
      return
    }

    await loadRedeemMailboxPage(redeemAccess.code, { page })
  }

  async function applyTempAccount() {
    const parsedAccount =
      parseAccountLine(tempAccountForm.email) ||
      parseAccountLine(tempAccountForm.refreshToken)
    const nextEmail = parsedAccount?.email || tempAccountForm.email.trim()
    const nextPassword =
      parsedAccount?.password ?? tempAccountForm.password.trim()
    const nextRefreshToken =
      parsedAccount?.refresh_token || tempAccountForm.refreshToken.trim()
    const nextClientId = parsedAccount?.client_id || ""

    if (!nextEmail || !nextRefreshToken) {
      notify(
        "临时账户不完整",
        "邮箱和 Refresh Token 为必填项。",
        "destructive"
      )
      return
    }

    const nextAccount: TempMailAccount = {
      email: nextEmail,
      password: nextPassword,
      client_id: nextClientId,
      refresh_token: nextRefreshToken,
    }

    setTempAccount(nextAccount)
    setTempAccountForm({
      email: nextEmail,
      password: nextPassword,
      refreshToken: nextRefreshToken,
    })
    sessionStorage.setItem(
      TEMP_ACCOUNT_STORAGE_KEY,
      JSON.stringify(nextAccount)
    )
    setTempDialogOpen(false)

    await activateMailbox(createTempMailboxEntry(nextAccount), "inbox")

    notify("临时账户已启用", `${nextEmail} 已作为当前邮箱载入。`)
  }

  function clearTempAccount() {
    const nextMailboxes = buildMailboxCollection(redeemMailboxes, null)
    const fallbackMailbox =
      nextMailboxes.find((item) => item.email === currentEmail) ||
      nextMailboxes[0] ||
      null

    setTempAccount(null)
    setTempAccountForm({
      email: "",
      password: "",
      refreshToken: "",
    })
    sessionStorage.removeItem(TEMP_ACCOUNT_STORAGE_KEY)
    setTempDialogOpen(false)

    if (fallbackMailbox) {
      void activateMailbox(fallbackMailbox, activeFolder)
      notify("临时账户已清除", "后续将恢复使用兑换结果中的邮箱配置。")
      return
    }

    setCurrentEmail("")
    resetMailboxView("inbox")
    notify(
      "临时账户已清除",
      "当前没有可用邮箱，请重新载入兑换码或添加临时账户。"
    )
  }

  function openAccountDetail(mailbox: MailboxEntry) {
    setAccountDetail(mailbox)
    setAccountDetailOpen(true)
  }

  function renderMailListTab(folder: MailFolder) {
    const list = mailLists[folder]
    const loading = folderLoading[folder]
    const selectedMessageId = selectedMessageIds[folder]
    const page = list?.page || 1
    const pageSize = DEFAULT_PAGE_SIZE
    const total = list?.total || 0
    const pageCount = Math.max(Math.ceil(total / pageSize), 1)
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        <div
          ref={(node) => {
            sidebarScrollRefs.current[folder] = node
          }}
          className="h-full min-h-0 flex-1 overflow-y-auto"
        >
          {loading ? (
            <div className="flex flex-col">
              {Array.from({ length: 5 }).map((_, index) => (
                <div
                  key={index}
                  className="border-b border-border/70 px-4 py-3 last:border-b-0"
                >
                  <div className="flex items-start justify-between gap-3">
                    <Skeleton className="h-4 w-1/3" />
                    <Skeleton className="h-3 w-14" />
                  </div>
                  <Skeleton className="mt-3 h-4 w-3/4" />
                  <Skeleton className="mt-2 h-8 w-full" />
                </div>
              ))}
            </div>
          ) : list?.items.length ? (
            <div className="flex flex-col">
              {list.items.map((message) => {
                const from = resolveMailAddress(
                  message.sender?.emailAddress || message.from?.emailAddress
                )

                return (
                  <button
                    key={`${folder}-${message.id}`}
                    type="button"
                    onClick={() => {
                      if (!selectedMailbox) {
                        return
                      }
                      void openMessageDetailForMailbox(
                        selectedMailbox,
                        message,
                        folder
                      )
                    }}
                    className={cn(
                      "flex w-full flex-col gap-1.5 border-b border-border/70 px-4 py-3 text-left transition last:border-b-0 hover:bg-muted/40",
                      selectedMessageId === message.id
                        ? "bg-muted"
                        : "bg-transparent"
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span className="truncate text-sm font-medium text-foreground">
                        {from.name}
                      </span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {formatMailDate(message.receivedDateTime)}
                      </span>
                    </div>
                    <span className="truncate text-sm text-foreground/90">
                      {message.subject || "(无主题)"}
                    </span>
                    <span className="line-clamp-2 text-xs text-muted-foreground">
                      {message.bodyPreview || "暂无摘要"}
                    </span>
                  </button>
                )
              })}
            </div>
          ) : (
            <div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
              {selectedMailbox ? null : "请先载入邮箱。"}
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-border/70 px-4 py-3 text-xs text-muted-foreground">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              第 {page} / {pageCount} 页，共 {total} 封
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!selectedMailbox || loading || page <= 1}
                onClick={() => void handleFolderPageChange(folder, page - 1)}
              >
                上一页
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!selectedMailbox || loading || page >= pageCount}
                onClick={() => void handleFolderPageChange(folder, page + 1)}
              >
                下一页
              </Button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const sidebarContent = (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <Tabs
        value={activeFolder}
        onValueChange={(value) => void handleFolderChange(value as MailFolder)}
        className="flex h-full min-h-0 flex-1 flex-col gap-0 overflow-hidden"
      >
        <div className="shrink-0 border-b border-border/70 px-4">
          <TabsList variant="line" className="w-full justify-start">
            <TabsTrigger value="inbox">
              收件箱
              <span className="text-muted-foreground">
                {mailLists.inbox?.total || 0}
              </span>
            </TabsTrigger>
            <TabsTrigger value="spam">
              垃圾箱
              <span className="text-muted-foreground">
                {mailLists.spam?.total || 0}
              </span>
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent
          value="inbox"
          className="mt-0 h-full min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden"
        >
          {renderMailListTab("inbox")}
        </TabsContent>
        <TabsContent
          value="spam"
          className="mt-0 h-full min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden"
        >
          {renderMailListTab("spam")}
        </TabsContent>
      </Tabs>
    </div>
  )

  return (
    <main className="page-shell page-shell-mail relative h-svh overflow-hidden font-sans">
      <div className="redeem-noise pointer-events-none absolute inset-0 opacity-60" />
      <div className="relative mx-auto flex h-full w-full max-w-7xl flex-col gap-4 px-4 py-4 md:px-6 lg:px-8">
        <header className="border-b border-border/70 pb-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-start gap-2">
              <h1 className="mt-1 text-lg text-foreground">
                Mail Inbox
              </h1>
              <InfoHint description="顶部按钮用于管理邮箱数据：兑换码会导入该卡密对应的邮箱数据，账户列表用于查看和切换已载入的数据，临时账户可手动导入整行账号配置，刷新会重新拉取当前邮箱当前文件夹的邮件。" />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <ThemeToggle />
              <Button variant="outline" size="sm" asChild>
                <a href="/redeem">兑换页</a>
              </Button>
            </div>
          </div>
        </header>

        {adSlot?.enabled ? (
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
        ) : null}

        <section className="grid min-h-0 flex-1 lg:grid-cols-[22rem_minmax(0,1fr)]">
          <Card className="gap-0 hidden min-h-0 border border-border/70 bg-card/92 backdrop-blur lg:flex lg:flex-col">
            <CardHeader className="border-b border-border/70">
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCodeDialogOpen(true)}
                >
                  <KeyRoundIcon data-icon="inline-start" />
                  兑换码
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setAccountsDialogOpen(true)}
                >
                  账户列表
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setTempDialogOpen(true)}
                >
                  <UserRoundPlusIcon data-icon="inline-start" />
                  临时账户
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!selectedMailbox || activeFolderLoading}
                  onClick={() => void handleRefreshCurrentFolder()}
                >
                  <RefreshCcwIcon data-icon="inline-start" />
                  刷新
                </Button>
              </div>
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col overflow-hidden p-0">
              {sidebarContent}
            </CardContent>
          </Card>

          <Card className="flex min-h-0 flex-col border border-border/70 bg-card/92 backdrop-blur">
            <CardHeader className="border-b border-border/70">
              <CardAction className="w-full lg:hidden">
                <div className="flex w-full items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1"
                    onClick={() => setSidebarSheetOpen(true)}
                  >
                    <LayoutPanelLeftIcon data-icon="inline-start" />
                    邮件列表
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm">
                        <EllipsisVerticalIcon data-icon="inline-start" />
                        更多
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        disabled={!selectedMailbox || activeFolderLoading}
                        onSelect={() => void handleRefreshCurrentFolder()}
                      >
                        刷新
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => setAccountsDialogOpen(true)}
                      >
                        账户列表
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setTempDialogOpen(true)}>
                        临时账户
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => setCodeDialogOpen(true)}>
                        载入兑换码
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </CardAction>
              <CardTitle>邮件内容</CardTitle>
              <CardDescription>
                {selectedMailbox
                  ? `${selectedMailbox.email} · ${formatFolderLabel(activeFolder)}`
                  : "从左侧列表选择一封邮件查看正文"}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex h-full min-h-0 flex-col overflow-hidden">
              {detailLoading ? (
                <div className="flex flex-col gap-5 py-4">
                  <Skeleton className="h-8 w-2/3" />
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3">
                      <Skeleton className="size-10 rounded-full" />
                      <div className="space-y-2">
                        <Skeleton className="h-4 w-32" />
                        <Skeleton className="h-3 w-48" />
                      </div>
                    </div>
                    <Skeleton className="h-4 w-24" />
                  </div>
                  <Skeleton className="h-80 w-full" />
                </div>
              ) : messageDetail ? (
                <article className="flex min-h-0 flex-1 flex-col overflow-hidden">
                  <div className="px-1">
                    <h2 className="font-medium tracking-tight text-foreground sm:text-[1.2rem]">
                      {messageDetail.subject || "(无主题)"}
                    </h2>
                    <div className="mt-5 flex items-start gap-4">
                      <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                        {(sender.name || sender.address || "?")
                          .slice(0, 1)
                          .toUpperCase()}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-foreground">
                              {sender.name}
                            </p>
                            {sender.address && sender.address !== sender.name ? (
                              <p className="truncate text-xs text-muted-foreground">
                                {sender.address}
                              </p>
                            ) : null}
                          </div>
                          <p className="shrink-0 text-xs text-muted-foreground">
                            {formatDetailMailDate(messageDetail.receivedDateTime)}
                          </p>
                        </div>
                        {recipients !== "未知收件人" ? (
                          <p className="mt-2 truncate text-xs text-muted-foreground">
                            发送给 {recipients}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  <Separator className="mt-5" />

                  <div className="min-h-0 flex-1 overflow-y-auto pt-5">
                    {isHtmlContent ? (
                      <div className="px-1">
                        <MailHtmlContent html={sanitizedBody} />
                      </div>
                    ) : (
                      <div className="px-1 text-[15px] leading-7 whitespace-pre-wrap break-words text-foreground">
                        {bodyContent || "(无内容)"}
                      </div>
                    )}
                  </div>
                </article>
              ) : (
                <div className="flex flex-1 items-center justify-center text-center text-sm text-muted-foreground">
                  先打开兑换码或临时账户，再从左侧 tab 中选择要查看的邮件。
                </div>
              )}
            </CardContent>
          </Card>
        </section>
      </div>

      <Sheet open={sidebarSheetOpen} onOpenChange={setSidebarSheetOpen}>
        <SheetContent side="left" className="w-[min(88vw,24rem)] p-0">
          <SheetHeader className="border-b border-border/70">
            <SheetTitle>邮件列表</SheetTitle>
            <SheetDescription>
              分页浏览收件箱与垃圾箱，点开左侧邮件后会自动切回正文。
            </SheetDescription>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 overflow-hidden">
            {sidebarContent}
          </div>
        </SheetContent>
      </Sheet>

      <Dialog open={codeDialogOpen} onOpenChange={setCodeDialogOpen}>
        <DialogContent className="max-w-[min(96vw,32rem)] p-0 sm:max-w-[min(96vw,32rem)]">
          <DialogHeader className="border-b border-border/70 px-5 py-4">
            <DialogTitle>载入兑换码</DialogTitle>
            <DialogDescription>
              输入兑换码后，会自动载入对应邮箱，并在账户列表弹窗中展示。
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex max-h-[min(72svh,24rem)] min-h-0 flex-col"
            onSubmit={loadMailboxesByCode}
          >
            <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-5 py-4">
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="mail-code">兑换码</FieldLabel>
                  <FieldContent>
                    <Input
                      id="mail-code"
                      value={code}
                      onChange={(event) => setCode(event.target.value)}
                      placeholder="输入兑换码载入邮箱"
                      autoComplete="off"
                    />
                  </FieldContent>
                </Field>
              </FieldGroup>
            </div>
            <DialogFooter className="border-t border-border/70 px-5 py-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => setCodeDialogOpen(false)}
              >
                取消
              </Button>
              <Button type="submit" disabled={codeLoading}>
                <KeyRoundIcon data-icon="inline-start" />
                {codeLoading ? "载入中..." : "载入邮箱"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={accountsDialogOpen} onOpenChange={setAccountsDialogOpen}>
        <DialogContent className="max-w-[min(96vw,72rem)] p-0 sm:max-w-[min(96vw,72rem)]">
          <DialogHeader className="border-b border-border/70 px-5 py-4">
            <DialogTitle>账户列表</DialogTitle>
            <DialogDescription>
              选择一个邮箱并直接打开收件箱或垃圾箱，详情仍可单独查看。
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[min(84svh,42rem)] overflow-auto px-5 py-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>邮箱</TableHead>
                  <TableHead>密码</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {accountListMailboxes.length ? (
                  accountListMailboxes.map((mailbox) => (
                    <TableRow
                      key={mailbox.id}
                      className={cn(
                        mailbox.email === currentEmail &&
                          "bg-primary/6 hover:bg-primary/8"
                      )}
                    >
                      <TableCell className="align-top">
                        <div className="flex items-center gap-2">
                          <code className="font-mono text-xs break-all">
                            {mailbox.email}
                          </code>
                          <Button
                            variant="outline"
                            size="xs"
                            onClick={() => void handleCopy(mailbox.email, "邮箱")}
                          >
                            <CopyIcon data-icon="inline-start" />
                            复制
                          </Button>
                        </div>
                      </TableCell>
                      <TableCell className="align-top">
                        <div className="flex items-center gap-2">
                          <code className="font-mono text-xs text-muted-foreground">
                            {mailbox.password || "未设置"}
                          </code>
                          {mailbox.password ? (
                            <Button
                              variant="outline"
                              size="xs"
                              onClick={() =>
                                void handleCopy(mailbox.password, "密码")
                              }
                            >
                              <CopyIcon data-icon="inline-start" />
                              复制
                            </Button>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="text-right align-top">
                        <div className="flex flex-wrap justify-end gap-2">
                          <Button
                            variant="outline"
                            size="xs"
                            onClick={() => {
                              setAccountsDialogOpen(false)
                              void activateMailbox(mailbox, "inbox")
                            }}
                          >
                            收件
                          </Button>
                          <Button
                            variant="outline"
                            size="xs"
                            onClick={() => {
                              setAccountsDialogOpen(false)
                              void activateMailbox(mailbox, "spam")
                            }}
                          >
                            垃圾
                          </Button>
                          <Button
                            variant="outline"
                            size="xs"
                            onClick={() => openAccountDetail(mailbox)}
                          >
                            <EyeIcon data-icon="inline-start" />
                            详情
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell
                      colSpan={3}
                      className="py-10 text-center text-sm text-muted-foreground"
                    >
                      先输入兑换码或启用临时账户，这里才会出现可切换的邮箱。
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <DialogFooter className="border-t border-border/70 px-5 py-4">
            {redeemMailboxPage ? (
              <div className="flex flex-1 flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
                <span>
                  第 {redeemMailboxPage.page} / {accountListPageCount} 页，共{" "}
                  {redeemMailboxPage.total} 个兑换邮箱
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={accountsLoading || redeemMailboxPage.page <= 1}
                    onClick={() =>
                      void handleRedeemMailboxPageChange(
                        redeemMailboxPage.page - 1
                      )
                    }
                  >
                    上一页
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={
                      accountsLoading || redeemMailboxPage.page >= accountListPageCount
                    }
                    onClick={() =>
                      void handleRedeemMailboxPageChange(
                        redeemMailboxPage.page + 1
                      )
                    }
                  >
                    下一页
                  </Button>
                </div>
              </div>
            ) : null}
            <Button type="button" onClick={() => setAccountsDialogOpen(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={accountDetailOpen} onOpenChange={setAccountDetailOpen}>
        <DialogContent className="max-w-[min(96vw,42rem)] p-0 sm:max-w-[min(96vw,42rem)]">
          <DialogHeader className="border-b border-border/70 px-5 py-4">
            <DialogTitle>邮箱详情</DialogTitle>
            <DialogDescription>
              查看当前邮箱账号的格式化信息与原始配置。
            </DialogDescription>
          </DialogHeader>
          <div className="flex max-h-[min(84svh,42rem)] min-h-0 flex-col gap-5 overflow-y-auto px-5 py-4">
            <FieldGroup>
              <Field>
                <FieldLabel>邮箱</FieldLabel>
                <FieldContent>
                  <Input value={accountDetail?.email || ""} readOnly />
                </FieldContent>
              </Field>
              <Field>
                <FieldLabel>密码</FieldLabel>
                <FieldContent>
                  <Input value={accountDetail?.password || ""} readOnly />
                </FieldContent>
              </Field>
              <Field>
                <FieldLabel>Client ID</FieldLabel>
                <FieldContent>
                  <Input value={accountDetail?.clientId || ""} readOnly />
                </FieldContent>
              </Field>
              <Field>
                <FieldLabel>Refresh Token</FieldLabel>
                <FieldContent>
                  <Textarea
                    rows={4}
                    value={accountDetail?.refreshToken || ""}
                    readOnly
                  />
                </FieldContent>
              </Field>
              <Field>
                <FieldLabel>原始数据</FieldLabel>
                <FieldContent>
                  <Textarea rows={4} value={accountDetail?.rawLine || ""} readOnly />
                </FieldContent>
              </Field>
            </FieldGroup>
          </div>
          <DialogFooter className="border-t border-border/70 px-5 py-4">
            {accountDetail?.email ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => void handleCopy(accountDetail.email, "邮箱")}
              >
                <CopyIcon data-icon="inline-start" />
                复制邮箱
              </Button>
            ) : null}
            <Button type="button" onClick={() => setAccountDetailOpen(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={tempDialogOpen} onOpenChange={setTempDialogOpen}>
        <DialogContent className="max-w-[min(96vw,42rem)] p-0 sm:max-w-[min(96vw,42rem)]">
          <DialogHeader className="border-b border-border/70 px-5 py-4">
            <DialogTitle>临时账户</DialogTitle>
            <DialogDescription>
              仅保存在当前浏览器会话内，不会写入服务器数据库。
            </DialogDescription>
          </DialogHeader>
          <div className="flex max-h-[min(84svh,42rem)] min-h-0 flex-col gap-5 overflow-y-auto px-5 py-4">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="temp-email">邮箱地址或整行配置</FieldLabel>
                <FieldContent>
                  <Input
                    id="temp-email"
                    value={tempAccountForm.email}
                    onChange={(event) =>
                      setTempAccountForm((current) => ({
                        ...current,
                        email: event.target.value,
                      }))
                    }
                    placeholder="可直接粘贴 email----password----client_id----refresh_token"
                  />
                </FieldContent>
              </Field>
              <Field>
                <FieldLabel htmlFor="temp-password">密码</FieldLabel>
                <FieldContent>
                  <Input
                    id="temp-password"
                    type="password"
                    autoComplete="current-password"
                    value={tempAccountForm.password}
                    onChange={(event) =>
                      setTempAccountForm((current) => ({
                        ...current,
                        password: event.target.value,
                      }))
                    }
                    placeholder="可选"
                  />
                </FieldContent>
              </Field>
              <Field>
                <FieldLabel htmlFor="temp-refresh-token">
                  Refresh Token
                </FieldLabel>
                <FieldContent>
                  <Textarea
                    id="temp-refresh-token"
                    rows={4}
                    value={tempAccountForm.refreshToken}
                    onChange={(event) =>
                      setTempAccountForm((current) => ({
                        ...current,
                        refreshToken: event.target.value,
                      }))
                    }
                    placeholder="请输入 Refresh Token，或直接粘贴整行配置"
                  />
                </FieldContent>
              </Field>
            </FieldGroup>
          </div>
          <DialogFooter className="border-t border-border/70 px-5 py-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => setTempDialogOpen(false)}
            >
              取消
            </Button>
            {tempAccount ? (
              <Button type="button" variant="outline" onClick={clearTempAccount}>
                清除
              </Button>
            ) : null}
            <Button type="button" onClick={() => void applyTempAccount()}>
              保存并使用
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  )
}
