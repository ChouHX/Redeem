import { useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowLeftIcon,
  CopyIcon,
  EllipsisVerticalIcon,
  InboxIcon,
  KeyRoundIcon,
  MailIcon,
  RefreshCcwIcon,
  SearchIcon,
  ShieldAlertIcon,
  UserRoundPlusIcon,
  XIcon,
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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
  DropdownMenuLabel,
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
type MobileView = "mailboxes" | "messages" | "detail"

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
    return date.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    })
  }

  if (diffDays === 1) {
    return `昨天 ${date.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    })}`
  }

  if (diffDays < 7) {
    return `${diffDays} 天前`
  }

  return date.toLocaleDateString("zh-CN", {
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
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

function mailboxInitial(mailbox: MailboxEntry) {
  return (mailbox.email || "?").slice(0, 1).toUpperCase()
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
  const [mobileMailboxesOpen, setMobileMailboxesOpen] = useState(false)
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
  const [mailboxFilter, setMailboxFilter] = useState("")
  const [messageFilter, setMessageFilter] = useState("")
  const [mobileView, setMobileView] = useState<MobileView>("messages")
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

  const filteredMailboxes = useMemo(() => {
    const query = mailboxFilter.trim().toLowerCase()
    if (!query) {
      return accountListMailboxes
    }
    return accountListMailboxes.filter((mailbox) =>
      mailbox.email.toLowerCase().includes(query)
    )
  }, [accountListMailboxes, mailboxFilter])

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

  const currentMailList = mailLists[activeFolder]
  const filteredMessages = useMemo(() => {
    if (!currentMailList) {
      return []
    }
    const query = messageFilter.trim().toLowerCase()
    if (!query) {
      return currentMailList.items
    }
    return currentMailList.items.filter((message) => {
      const subject = (message.subject || "").toLowerCase()
      const preview = (message.bodyPreview || "").toLowerCase()
      const from = resolveMailAddress(
        message.sender?.emailAddress || message.from?.emailAddress
      )
      const fromText = `${from.name} ${from.address}`.toLowerCase()
      return (
        subject.includes(query) ||
        preview.includes(query) ||
        fromText.includes(query)
      )
    })
  }, [currentMailList, messageFilter])

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
    setMobileView("detail")

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
    setMobileView("messages")
    setMobileMailboxesOpen(false)
    return loadFolderMessages(mailbox, folder, {
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
      preserveSelection: false,
    })
  }

  async function handleFolderChange(folder: MailFolder) {
    setActiveFolder(folder)
    setMessageFilter("")

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
    }: {
      page?: number
      replaceCache?: boolean
      activateFirst?: boolean
      resetOnError?: boolean
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
      })
      if (!payload) {
        return
      }

      notify(
        "邮箱已载入",
        payload.source === "newly_redeemed"
          ? "兑换码已自动兑换，已载入对应邮箱。"
          : `共 ${payload.total} 个邮箱，已为你选中第一个。`
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

  const mailboxesPanel = (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border/70 px-3 py-3">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={mailboxFilter}
            onChange={(event) => setMailboxFilter(event.target.value)}
            placeholder="搜索邮箱"
            className="h-8 pl-8"
          />
          {mailboxFilter ? (
            <button
              type="button"
              aria-label="清除搜索"
              className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => setMailboxFilter("")}
            >
              <XIcon className="size-3.5" />
            </button>
          ) : null}
        </div>
        <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
          <span>
            {filteredMailboxes.length} / {accountListMailboxes.length} 个邮箱
          </span>
          {redeemMailboxPage ? (
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="上一页"
                disabled={accountsLoading || redeemMailboxPage.page <= 1}
                onClick={() =>
                  void handleRedeemMailboxPageChange(redeemMailboxPage.page - 1)
                }
              >
                ‹
              </Button>
              <span>
                {redeemMailboxPage.page}/{accountListPageCount}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="下一页"
                disabled={
                  accountsLoading || redeemMailboxPage.page >= accountListPageCount
                }
                onClick={() =>
                  void handleRedeemMailboxPageChange(redeemMailboxPage.page + 1)
                }
              >
                ›
              </Button>
            </div>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {filteredMailboxes.length ? (
          <ul className="flex flex-col">
            {filteredMailboxes.map((mailbox) => {
              const isActive = mailbox.email === currentEmail
              return (
                <li key={mailbox.id}>
                  <button
                    type="button"
                    onClick={() => void activateMailbox(mailbox, "inbox")}
                    className={cn(
                      "group/mailbox flex w-full items-center gap-3 border-b border-border/60 px-3 py-2.5 text-left transition last:border-b-0 hover:bg-muted/40",
                      isActive && "bg-primary/10 hover:bg-primary/12"
                    )}
                  >
                    <div
                      className={cn(
                        "flex size-8 shrink-0 items-center justify-center rounded-none bg-muted font-medium text-muted-foreground",
                        isActive && "bg-primary text-primary-foreground"
                      )}
                    >
                      {mailboxInitial(mailbox)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            "truncate text-xs font-medium text-foreground",
                            isActive && "text-foreground"
                          )}
                        >
                          {mailbox.email}
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                        <Badge
                          variant={
                            mailbox.sourceType === "temp" ? "default" : "outline"
                          }
                          className="h-4 px-1.5 text-[10px]"
                        >
                          {mailbox.sourceType === "temp"
                            ? "临时"
                            : mailbox.sourceLabel || "兑换"}
                        </Badge>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="opacity-0 transition-opacity group-hover/mailbox:opacity-100 data-[state=open]:opacity-100"
                      aria-label="更多"
                      onClick={(event) => {
                        event.stopPropagation()
                        openAccountDetail(mailbox)
                      }}
                    >
                      <EllipsisVerticalIcon />
                    </Button>
                  </button>
                </li>
              )
            })}
          </ul>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-4 py-10 text-center text-xs text-muted-foreground">
            {accountListMailboxes.length ? (
              <p>没有匹配「{mailboxFilter}」的邮箱</p>
            ) : (
              <>
                <InboxIcon className="size-8 text-muted-foreground/60" />
                <p>还没有邮箱，先载入一个兑换码或添加临时账户。</p>
                <div className="flex flex-wrap justify-center gap-2">
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
                    onClick={() => setTempDialogOpen(true)}
                  >
                    <UserRoundPlusIcon data-icon="inline-start" />
                    临时账户
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border/70 p-2">
        <div className="flex gap-1">
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={() => setCodeDialogOpen(true)}
          >
            <KeyRoundIcon data-icon="inline-start" />
            兑换码
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={() => setTempDialogOpen(true)}
          >
            <UserRoundPlusIcon data-icon="inline-start" />
            临时账户
          </Button>
        </div>
      </div>
    </div>
  )

  const messagesPanel = (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border/70 px-3 pt-3 pb-2">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            className="md:hidden"
            aria-label="返回邮箱列表"
            onClick={() => setMobileView("mailboxes")}
          >
            <ArrowLeftIcon />
          </Button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="truncate text-xs font-medium text-foreground">
                {selectedMailbox?.email || "未选择邮箱"}
              </p>
              {selectedMailbox ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="复制邮箱"
                      onClick={() =>
                        void handleCopy(selectedMailbox.email, "邮箱")
                      }
                    >
                      <CopyIcon />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>复制邮箱</TooltipContent>
                </Tooltip>
              ) : null}
            </div>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="刷新当前文件夹"
                disabled={!selectedMailbox || activeFolderLoading}
                onClick={() => void handleRefreshCurrentFolder()}
              >
                <RefreshCcwIcon
                  className={cn(activeFolderLoading && "animate-spin")}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent>刷新</TooltipContent>
          </Tooltip>
        </div>

        <Tabs
          value={activeFolder}
          onValueChange={(value) => void handleFolderChange(value as MailFolder)}
          className="mt-2"
        >
          <TabsList variant="line" className="w-full justify-start">
            <TabsTrigger value="inbox">
              <InboxIcon />
              收件箱
              <span className="text-muted-foreground">
                {mailLists.inbox?.total ?? "·"}
              </span>
            </TabsTrigger>
            <TabsTrigger value="spam">
              <ShieldAlertIcon />
              垃圾箱
              <span className="text-muted-foreground">
                {mailLists.spam?.total ?? "·"}
              </span>
            </TabsTrigger>
          </TabsList>
          <TabsContent value="inbox" className="hidden" />
          <TabsContent value="spam" className="hidden" />
        </Tabs>

        <div className="relative mt-2">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={messageFilter}
            onChange={(event) => setMessageFilter(event.target.value)}
            placeholder="搜索当前文件夹"
            className="h-8 pl-8"
            disabled={!selectedMailbox}
          />
          {messageFilter ? (
            <button
              type="button"
              aria-label="清除搜索"
              className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => setMessageFilter("")}
            >
              <XIcon className="size-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      <div
        ref={(node) => {
          sidebarScrollRefs.current[activeFolder] = node
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {activeFolderLoading ? (
          <div className="flex flex-col">
            {Array.from({ length: 5 }).map((_, index) => (
              <div
                key={index}
                className="border-b border-border/60 px-3 py-3 last:border-b-0"
              >
                <div className="flex items-start justify-between gap-3">
                  <Skeleton className="h-3 w-1/3" />
                  <Skeleton className="h-3 w-10" />
                </div>
                <Skeleton className="mt-2 h-3.5 w-3/4" />
                <Skeleton className="mt-1.5 h-3 w-full" />
              </div>
            ))}
          </div>
        ) : !selectedMailbox ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-xs text-muted-foreground">
            <MailIcon className="size-8 text-muted-foreground/60" />
            <p>从左侧选择一个邮箱开始查看邮件。</p>
          </div>
        ) : filteredMessages.length ? (
          <ul className="flex flex-col">
            {filteredMessages.map((message) => {
              const from = resolveMailAddress(
                message.sender?.emailAddress || message.from?.emailAddress
              )
              const isActive = selectedMessageIds[activeFolder] === message.id

              return (
                <li key={`${activeFolder}-${message.id}`}>
                  <button
                    type="button"
                    onClick={() => {
                      if (!selectedMailbox) {
                        return
                      }
                      void openMessageDetailForMailbox(
                        selectedMailbox,
                        message,
                        activeFolder
                      )
                    }}
                    className={cn(
                      "relative flex w-full flex-col gap-1 border-b border-border/60 px-3 py-2.5 text-left transition last:border-b-0 hover:bg-muted/40",
                      isActive && "bg-muted"
                    )}
                  >
                    {isActive ? (
                      <span className="absolute top-0 bottom-0 left-0 w-[2px] bg-primary" />
                    ) : null}
                    <div className="flex items-start justify-between gap-3">
                      <span className="truncate text-xs font-medium text-foreground">
                        {from.name}
                      </span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {formatMailDate(message.receivedDateTime)}
                      </span>
                    </div>
                    <span className="truncate text-xs text-foreground/90">
                      {message.subject || "(无主题)"}
                    </span>
                    <span className="line-clamp-2 text-[11px] text-muted-foreground">
                      {message.bodyPreview || "暂无摘要"}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-xs text-muted-foreground">
            {currentMailList?.items.length ? (
              <p>没有匹配「{messageFilter}」的邮件</p>
            ) : (
              <>
                <MailIcon className="size-8 text-muted-foreground/60" />
                <p>
                  {formatFolderLabel(activeFolder)}为空，试试点击刷新。
                </p>
              </>
            )}
          </div>
        )}
      </div>

      {currentMailList ? (
        <div className="shrink-0 border-t border-border/70 px-3 py-2 text-[11px] text-muted-foreground">
          <div className="flex items-center justify-between gap-2">
            <span>
              第 {currentMailList.page} /{" "}
              {Math.max(
                Math.ceil(currentMailList.total / DEFAULT_PAGE_SIZE),
                1
              )}{" "}
              页 · 共 {currentMailList.total} 封
            </span>
            <div className="flex gap-1">
              <Button
                variant="outline"
                size="xs"
                disabled={
                  !selectedMailbox ||
                  activeFolderLoading ||
                  currentMailList.page <= 1
                }
                onClick={() =>
                  void handleFolderPageChange(
                    activeFolder,
                    currentMailList.page - 1
                  )
                }
              >
                上一页
              </Button>
              <Button
                variant="outline"
                size="xs"
                disabled={
                  !selectedMailbox ||
                  activeFolderLoading ||
                  currentMailList.page >=
                    Math.max(
                      Math.ceil(currentMailList.total / DEFAULT_PAGE_SIZE),
                      1
                    )
                }
                onClick={() =>
                  void handleFolderPageChange(
                    activeFolder,
                    currentMailList.page + 1
                  )
                }
              >
                下一页
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )

  const detailPanel = (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/70 px-4 py-2.5 md:hidden">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="返回邮件列表"
          onClick={() => setMobileView("messages")}
        >
          <ArrowLeftIcon />
        </Button>
        <p className="truncate text-xs text-muted-foreground">
          {selectedMailbox?.email} · {formatFolderLabel(activeFolder)}
        </p>
      </div>

      {detailLoading ? (
        <div className="flex flex-col gap-5 px-6 py-6">
          <Skeleton className="h-7 w-2/3" />
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Skeleton className="size-10 rounded-full" />
              <div className="space-y-2">
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-3 w-48" />
              </div>
            </div>
            <Skeleton className="h-3.5 w-24" />
          </div>
          <Skeleton className="h-80 w-full" />
        </div>
      ) : messageDetail ? (
        <article className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="shrink-0 px-6 pt-5 pb-4">
            <h2 className="font-heading text-base font-medium tracking-tight text-foreground sm:text-lg">
              {messageDetail.subject || "(无主题)"}
            </h2>
            <div className="mt-4 flex items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                {(sender.name || sender.address || "?")
                  .slice(0, 1)
                  .toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium text-foreground">
                      {sender.name}
                    </p>
                    {sender.address && sender.address !== sender.name ? (
                      <p className="truncate text-[11px] text-muted-foreground">
                        {sender.address}
                      </p>
                    ) : null}
                  </div>
                  <p className="shrink-0 text-[11px] text-muted-foreground">
                    {formatDetailMailDate(messageDetail.receivedDateTime)}
                  </p>
                </div>
                {recipients !== "未知收件人" ? (
                  <p className="mt-1.5 truncate text-[11px] text-muted-foreground">
                    发送给 {recipients}
                  </p>
                ) : null}
              </div>
            </div>
          </div>

          <Separator />

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            {isHtmlContent ? (
              <MailHtmlContent html={sanitizedBody} />
            ) : (
              <div className="text-sm leading-7 whitespace-pre-wrap break-words text-foreground">
                {bodyContent || "(无内容)"}
              </div>
            )}
          </div>
        </article>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-xs text-muted-foreground">
          <MailIcon className="size-10 text-muted-foreground/60" />
          <p className="max-w-xs">
            {selectedMailbox
              ? "从中间列表选择一封邮件查看正文。"
              : "先载入兑换码或添加临时账户，再选择邮件查看。"}
          </p>
        </div>
      )}
    </div>
  )

  return (
    <main className="page-shell page-shell-mail relative flex h-svh flex-col overflow-hidden font-sans">
      <div className="redeem-noise pointer-events-none absolute inset-0 opacity-60" />

      <header className="relative z-10 shrink-0 border-b border-border/70 bg-background/70 backdrop-blur">
        <div className="mx-auto flex w-full max-w-[104rem] items-center gap-2 px-3 py-2.5 sm:px-4 md:px-6">
          <div className="flex items-center gap-2">
            <MailIcon className="size-4 text-primary" />
            <span className="font-heading text-sm font-medium">Mail</span>
          </div>

          <div className="ml-2 hidden min-w-0 flex-1 items-center gap-2 md:flex">
            {selectedMailbox ? (
              <>
                <Badge variant="outline" className="h-5">
                  {selectedMailbox.sourceType === "temp"
                    ? "临时"
                    : selectedMailbox.sourceLabel || "兑换"}
                </Badge>
                <p className="truncate text-xs text-foreground/80">
                  {selectedMailbox.email}
                </p>
              </>
            ) : (
              <p className="truncate text-xs text-muted-foreground">
                未选择邮箱
              </p>
            )}
          </div>

          <Button
            variant="outline"
            size="sm"
            className="ml-auto md:hidden"
            onClick={() => setMobileMailboxesOpen(true)}
          >
            <InboxIcon data-icon="inline-start" />
            邮箱
            {accountListMailboxes.length ? (
              <span className="text-muted-foreground">
                {accountListMailboxes.length}
              </span>
            ) : null}
          </Button>

          <div className="hidden items-center gap-1 md:flex">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="刷新"
                  disabled={!selectedMailbox || activeFolderLoading}
                  onClick={() => void handleRefreshCurrentFolder()}
                >
                  <RefreshCcwIcon
                    className={cn(activeFolderLoading && "animate-spin")}
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent>刷新当前文件夹</TooltipContent>
            </Tooltip>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="更多操作">
                <EllipsisVerticalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>账户管理</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => setCodeDialogOpen(true)}>
                <KeyRoundIcon />
                载入兑换码
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setTempDialogOpen(true)}>
                <UserRoundPlusIcon />
                {tempAccount ? "编辑临时账户" : "添加临时账户"}
              </DropdownMenuItem>
              {selectedMailbox ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() => openAccountDetail(selectedMailbox)}
                  >
                    查看当前邮箱配置
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() =>
                      void handleCopy(selectedMailbox.email, "邮箱")
                    }
                  >
                    <CopyIcon />
                    复制邮箱地址
                  </DropdownMenuItem>
                </>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <a href="/redeem">前往兑换页</a>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <ThemeToggle />
        </div>

        {adSlot?.enabled ? (
          <div className="mx-auto w-full max-w-[104rem] px-3 pb-3 sm:px-4 md:px-6">
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
      </header>

      <section className="relative z-10 mx-auto flex w-full max-w-[104rem] min-h-0 flex-1 gap-0 overflow-hidden px-0 md:px-3 md:py-3 lg:px-6">
        {/* Desktop three-pane layout */}
        <div className="hidden w-full min-h-0 border border-border/70 bg-card/92 backdrop-blur md:grid md:grid-cols-[16rem_minmax(18rem,22rem)_minmax(0,1fr)] lg:grid-cols-[18rem_minmax(20rem,24rem)_minmax(0,1fr)]">
          <div className="min-h-0 border-r border-border/70">
            {mailboxesPanel}
          </div>
          <div className="min-h-0 border-r border-border/70">
            {messagesPanel}
          </div>
          <div className="min-h-0">{detailPanel}</div>
        </div>

        {/* Mobile stacked views */}
        <div className="flex w-full min-h-0 flex-col md:hidden">
          {mobileView === "messages" ? (
            <div className="min-h-0 flex-1 bg-card/92 backdrop-blur">
              {messagesPanel}
            </div>
          ) : mobileView === "detail" ? (
            <div className="min-h-0 flex-1 bg-card/92 backdrop-blur">
              {detailPanel}
            </div>
          ) : (
            <div className="min-h-0 flex-1 bg-card/92 backdrop-blur">
              {mailboxesPanel}
            </div>
          )}
        </div>
      </section>

      {/* Mobile: mailboxes drawer */}
      <Sheet open={mobileMailboxesOpen} onOpenChange={setMobileMailboxesOpen}>
        <SheetContent side="left" className="w-[min(88vw,22rem)] p-0">
          <SheetHeader className="border-b border-border/70">
            <SheetTitle>邮箱</SheetTitle>
            <SheetDescription>
              选择一个邮箱打开，或添加新的兑换码/临时账户。
            </SheetDescription>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 overflow-hidden">
            {mailboxesPanel}
          </div>
        </SheetContent>
      </Sheet>

      {/* Code dialog */}
      <Dialog open={codeDialogOpen} onOpenChange={setCodeDialogOpen}>
        <DialogContent className="max-w-[min(96vw,30rem)] p-0 sm:max-w-[min(96vw,30rem)]">
          <DialogHeader className="border-b border-border/70 px-5 py-4">
            <DialogTitle>载入兑换码</DialogTitle>
            <DialogDescription>
              输入兑换码即可载入对应邮箱，并自动选中第一个。
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex max-h-[min(72svh,22rem)] min-h-0 flex-col"
            onSubmit={loadMailboxesByCode}
          >
            <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-5 py-4">
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
                      autoFocus
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

      {/* Account detail dialog */}
      <Dialog open={accountDetailOpen} onOpenChange={setAccountDetailOpen}>
        <DialogContent className="max-w-[min(96vw,40rem)] p-0 sm:max-w-[min(96vw,40rem)]">
          <DialogHeader className="border-b border-border/70 px-5 py-4">
            <DialogTitle>邮箱配置</DialogTitle>
            <DialogDescription>
              查看当前邮箱的格式化信息与原始配置。
            </DialogDescription>
          </DialogHeader>
          <div className="flex max-h-[min(84svh,40rem)] min-h-0 flex-col gap-5 overflow-y-auto px-5 py-4">
            <FieldGroup>
              <Field>
                <FieldLabel>邮箱</FieldLabel>
                <FieldContent>
                  <div className="flex items-center gap-2">
                    <Input
                      value={accountDetail?.email || ""}
                      readOnly
                      className="flex-1"
                    />
                    {accountDetail?.email ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          void handleCopy(accountDetail.email, "邮箱")
                        }
                      >
                        <CopyIcon data-icon="inline-start" />
                        复制
                      </Button>
                    ) : null}
                  </div>
                </FieldContent>
              </Field>
              <Field>
                <FieldLabel>密码</FieldLabel>
                <FieldContent>
                  <div className="flex items-center gap-2">
                    <Input
                      value={accountDetail?.password || ""}
                      readOnly
                      className="flex-1"
                    />
                    {accountDetail?.password ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          void handleCopy(accountDetail.password, "密码")
                        }
                      >
                        <CopyIcon data-icon="inline-start" />
                        复制
                      </Button>
                    ) : null}
                  </div>
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
                  <Textarea
                    rows={4}
                    value={accountDetail?.rawLine || ""}
                    readOnly
                  />
                </FieldContent>
              </Field>
            </FieldGroup>
          </div>
          <DialogFooter className="border-t border-border/70 px-5 py-4">
            <Button type="button" onClick={() => setAccountDetailOpen(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Temp account dialog */}
      <Dialog open={tempDialogOpen} onOpenChange={setTempDialogOpen}>
        <DialogContent className="max-w-[min(96vw,40rem)] p-0 sm:max-w-[min(96vw,40rem)]">
          <DialogHeader className="border-b border-border/70 px-5 py-4">
            <DialogTitle>临时账户</DialogTitle>
            <DialogDescription>
              仅保存在当前浏览器会话内，不会写入服务器数据库。
            </DialogDescription>
          </DialogHeader>
          <div className="flex max-h-[min(84svh,40rem)] min-h-0 flex-col gap-5 overflow-y-auto px-5 py-4">
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
