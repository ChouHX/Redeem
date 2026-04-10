import { useEffect, useRef, useState } from "react"
import {
  CopyIcon,
  DownloadIcon,
  EllipsisVerticalIcon,
  EyeIcon,
  FileUpIcon,
  KeyRoundIcon,
  Layers3Icon,
  LogOutIcon,
  MailIcon,
  PackagePlusIcon,
  PlusIcon,
  RefreshCcwIcon,
  SearchIcon,
  ShieldIcon,
  TicketIcon,
  UserCogIcon,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  type AdSlotConfig,
  ApiError,
  type AdminOverview,
  type FieldSchema,
  type PagedResult,
  batchUpdateAdminCodes,
  batchDeleteAdminCodes,
  batchUpdateAdminInventory,
  batchUpdateAdminCodeStatus,
  batchDeleteAdminInventory,
  exportAdminCodesText,
  exportAdminInventoryText,
  fetchAdminAds,
  type RedeemCodeItem,
  type RedeemInventoryItem,
  type RedeemRecordDetail,
  type RedeemRecordGroup,
  type RedeemRecordItem,
  type RedeemType,
  type TypeFormPayload,
  createAdminType,
  deleteAdminCode,
  deleteAdminInventory,
  fetchAdminCodes,
  fetchAdminInventory,
  fetchAdminOverview,
  fetchAdminRecordDetail,
  fetchAdminRecords,
  fetchAdminTypes,
  generateAdminCodes,
  importAdminInventory,
  updateAdminCodeStatus,
  updateAdminInventoryStatus,
  updateAdminAds,
  updateAdminPassword,
  updateAdminType,
  verifyAdminToken,
} from "@/lib/api"
import { AdSlotCard } from "@/components/ad-slot-card"
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
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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
import { toast } from "sonner"
import { ThemeToggle } from "@/components/theme-toggle"
import { createTextExportFilename, downloadTextFile } from "@/lib/utils"

type TypeEditorState = TypeFormPayload

type InventoryFilters = {
  typeId: string
  status: string
  q: string
  page: number
  pageSize: number
}

type CodeFilters = {
  typeId: string
  status: string
  q: string
  minQuantity: string
  maxQuantity: string
  page: number
  pageSize: number
}

type RecordFilters = {
  typeId: string
  q: string
  page: number
  pageSize: number
}

type PasswordFormState = {
  currentToken: string
  newToken: string
}

type InventoryBatchEditState = {
  typeId: string
  status: string
}

type CodeBatchEditState = {
  typeId: string
  quantity: string
}

const MAX_RECORD_PREVIEW_ITEMS = 10

function createDefaultFields(): FieldSchema {
  return {
    key: "raw_line",
    label: "原始数据",
    required: true,
    sensitive: false,
    placeholder: "整行数据",
  }
}

function createTypeEditorState(type?: RedeemType): TypeEditorState {
  if (type) {
    return {
      name: type.name,
      slug: type.slug,
      description: type.description || "",
      import_delimiter: "----",
      is_active: type.is_active,
      field_schema: [createDefaultFields()],
    }
  }

  return {
    name: "",
    slug: "",
    description: "",
    import_delimiter: "----",
    is_active: true,
    field_schema: [createDefaultFields()],
  }
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

function toDatetimeLocal(value: string | null | undefined) {
  if (!value) {
    return ""
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return ""
  }

  const offset = date.getTimezoneOffset()
  const localDate = new Date(date.getTime() - offset * 60 * 1000)
  return localDate.toISOString().slice(0, 16)
}

function truncateText(value: string, max = 52) {
  if (value.length <= max) {
    return value
  }

  return `${value.slice(0, max)}...`
}

function recordLine(record: RedeemRecordItem) {
  const delimiter = record.import_delimiter || "----"
  const fields = record.field_schema || []
  if (!fields.length) {
    return Object.values(record.payload || {}).join(delimiter)
  }

  return fields
    .map((field) => record.payload?.[field.key] || "")
    .join(delimiter)
}

function inventoryStatusLabel(status: RedeemInventoryItem["status"]) {
  switch (status) {
    case "available":
      return "可用"
    case "unavailable":
      return "不可用"
    case "redeemed":
      return "已兑换"
    default:
      return status
  }
}

function codeStatusLabel(status: RedeemCodeItem["derived_status"]) {
  switch (status) {
    case "unused":
      return "可用"
    case "redeemed":
      return "已兑换"
    case "disabled":
      return "已禁用"
    case "expired":
      return "已过期"
    default:
      return status
  }
}

async function readTextFile(file: File) {
  return await file.text()
}

function SectionPager({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  onPrev,
  onNext,
}: {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
  onPageSizeChange: (pageSize: number) => void
  onPrev: () => void
  onNext: () => void
}) {
  const maxPage = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className="flex flex-col gap-3 border-t border-border/70 px-4 py-3 text-xs text-muted-foreground md:flex-row md:items-center md:justify-between">
      <span>
        第 {page} / {maxPage} 页，共 {total} 条
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={String(pageSize)}
          onValueChange={(value) => onPageSizeChange(Number(value))}
        >
          <SelectTrigger className="w-[7.5rem]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {[10, 20, 50, 100].map((size) => (
                <SelectItem key={size} value={String(size)}>
                  每页 {size} 条
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Select
          value={String(page)}
          onValueChange={(value) => onPageChange(Number(value))}
        >
          <SelectTrigger className="w-[6rem]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {Array.from({ length: maxPage }, (_, index) => index + 1).map(
                (pageNumber) => (
                  <SelectItem key={pageNumber} value={String(pageNumber)}>
                    第 {pageNumber} 页
                  </SelectItem>
                )
              )}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="sm"
          onClick={onPrev}
          disabled={page <= 1}
        >
          上一页
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onNext}
          disabled={page >= maxPage}
        >
          下一页
        </Button>
      </div>
    </div>
  )
}

function AdSlotEditorCard({
  slot,
  onEnabledChange,
  onFieldChange,
  onActionChange,
}: {
  slot: AdSlotConfig
  onEnabledChange: (enabled: boolean) => void
  onFieldChange: (
    key:
      | "title"
      | "description"
      | "image_url",
    value: string | string[]
  ) => void
  onActionChange: (
    actionKey: "primary_action",
    field: "label" | "href",
    value: string
  ) => void
}) {
  return (
    <Card className="mx-auto w-full max-w-3xl border border-border/70 bg-background/70">
      <CardHeader className="border-b border-border/70">
        <CardTitle>共享广告位</CardTitle>
        <CardDescription>兑换页与收件页共用同一份广告配置</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="flex flex-col gap-4">
          <div className="rounded-none border border-border/70 bg-muted/20 px-3 py-2 text-sm text-foreground">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={slot.enabled}
                onChange={(event) => onEnabledChange(event.currentTarget.checked)}
              />
              启用共享广告位
            </label>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Field>
              <FieldLabel>标题</FieldLabel>
              <FieldContent>
                <Input
                  value={slot.title}
                  onChange={(event) => onFieldChange("title", event.target.value)}
                />
              </FieldContent>
            </Field>
            <Field>
              <FieldLabel>主按钮文案</FieldLabel>
              <FieldContent>
                <Input
                  value={slot.primary_action.label}
                  onChange={(event) =>
                    onActionChange("primary_action", "label", event.target.value)
                  }
                />
              </FieldContent>
            </Field>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Field>
              <FieldLabel>图片 / 动图 URL</FieldLabel>
              <FieldContent>
                <Input
                  value={slot.image_url}
                  onChange={(event) => onFieldChange("image_url", event.target.value)}
                  placeholder="例如 /ads/redeem.gif 或 https://..."
                />
              </FieldContent>
            </Field>
            <Field>
              <FieldLabel>主按钮链接</FieldLabel>
              <FieldContent>
                <Input
                  value={slot.primary_action.href}
                  onChange={(event) =>
                    onActionChange("primary_action", "href", event.target.value)
                  }
                />
              </FieldContent>
            </Field>
          </div>

          <Field>
            <FieldLabel>描述</FieldLabel>
            <FieldContent>
              <Textarea
                rows={3}
                value={slot.description}
                onChange={(event) => onFieldChange("description", event.target.value)}
              />
            </FieldContent>
          </Field>

        </div>

        <Separator />

        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">预览</p>
          <AdSlotCard
            title={slot.title}
            description={slot.description}
            imageUrl={slot.image_url}
            primaryAction={slot.primary_action.href ? slot.primary_action : undefined}
            compact
          />
        </div>
      </CardContent>
    </Card>
  )
}

export function AdminConsole() {
  const [token, setToken] = useState("")
  const [tokenInput, setTokenInput] = useState("")
  const [authenticated, setAuthenticated] = useState(false)
  const [checkingAuth, setCheckingAuth] = useState(true)
  const [activeTab, setActiveTab] = useState("inventory")
  const [overview, setOverview] = useState<AdminOverview | null>(null)
  const [adSlot, setAdSlot] = useState<AdSlotConfig | null>(null)
  const [types, setTypes] = useState<RedeemType[]>([])
  const [inventory, setInventory] =
    useState<PagedResult<RedeemInventoryItem> | null>(null)
  const [codes, setCodes] = useState<PagedResult<RedeemCodeItem> | null>(null)
  const [records, setRecords] = useState<PagedResult<RedeemRecordGroup> | null>(
    null
  )
  const [inventoryLoading, setInventoryLoading] = useState(false)
  const [codesLoading, setCodesLoading] = useState(false)
  const [recordsLoading, setRecordsLoading] = useState(false)
  const [overviewLoading, setOverviewLoading] = useState(false)
  const [adsLoading, setAdsLoading] = useState(false)
  const [typeDialogOpen, setTypeDialogOpen] = useState(false)
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false)
  const [inventoryImportDialogOpen, setInventoryImportDialogOpen] =
    useState(false)
  const [inventoryBatchEditDialogOpen, setInventoryBatchEditDialogOpen] =
    useState(false)
  const [codeGenerateDialogOpen, setCodeGenerateDialogOpen] = useState(false)
  const [codeBatchEditDialogOpen, setCodeBatchEditDialogOpen] = useState(false)
  const [recordDetailDialogOpen, setRecordDetailDialogOpen] = useState(false)
  const [editingType, setEditingType] = useState<RedeemType | null>(null)
  const [typeEditor, setTypeEditor] = useState<TypeEditorState>(
    createTypeEditorState()
  )
  const [typeSubmitting, setTypeSubmitting] = useState(false)
  const [inventorySubmitting, setInventorySubmitting] = useState(false)
  const [inventoryBatchSubmitting, setInventoryBatchSubmitting] =
    useState(false)
  const [codeSubmitting, setCodeSubmitting] = useState(false)
  const [codeBatchSubmitting, setCodeBatchSubmitting] = useState(false)
  const [passwordSubmitting, setPasswordSubmitting] = useState(false)
  const [adsSubmitting, setAdsSubmitting] = useState(false)
  const [generatedCodes, setGeneratedCodes] = useState<RedeemCodeItem[]>([])
  const [inventoryFilters, setInventoryFilters] = useState<InventoryFilters>({
    typeId: "",
    status: "",
    q: "",
    page: 1,
    pageSize: 10,
  })
  const [codeFilters, setCodeFilters] = useState<CodeFilters>({
    typeId: "",
    status: "",
    q: "",
    minQuantity: "",
    maxQuantity: "",
    page: 1,
    pageSize: 10,
  })
  const [recordFilters, setRecordFilters] = useState<RecordFilters>({
    typeId: "",
    q: "",
    page: 1,
    pageSize: 10,
  })
  const [inventoryImportTypeId, setInventoryImportTypeId] = useState("")
  const [inventoryImportMode, setInventoryImportMode] = useState("append")
  const [inventoryImportText, setInventoryImportText] = useState("")
  const [inventoryBatchEdit, setInventoryBatchEdit] =
    useState<InventoryBatchEditState>({
      typeId: "",
      status: "",
    })
  const [generateTypeId, setGenerateTypeId] = useState("")
  const [generateCount, setGenerateCount] = useState("10")
  const [generateQuantity, setGenerateQuantity] = useState("1")
  const [generateNote, setGenerateNote] = useState("")
  const [generateExpiresAt, setGenerateExpiresAt] = useState("")
  const [codeBatchEdit, setCodeBatchEdit] = useState<CodeBatchEditState>({
    typeId: "",
    quantity: "",
  })
  const [selectedInventoryIds, setSelectedInventoryIds] = useState<number[]>([])
  const [selectedCodeIds, setSelectedCodeIds] = useState<number[]>([])
  const [passwordForm, setPasswordForm] = useState<PasswordFormState>({
    currentToken: "",
    newToken: "",
  })
  const [recordDetailLoading, setRecordDetailLoading] = useState(false)
  const [recordDetail, setRecordDetail] = useState<RedeemRecordDetail | null>(
    null
  )
  const inventoryImportFileInputRef = useRef<HTMLInputElement | null>(null)

  function setDefaultTypeSelections(nextTypes: RedeemType[]) {
    const firstTypeId = nextTypes[0] ? String(nextTypes[0].id) : ""
    if (!firstTypeId) {
      return
    }

    setInventoryImportTypeId((current) => current || firstTypeId)
    setGenerateTypeId((current) => current || firstTypeId)
  }

  function showToast(title: string, description: string) {
    toast(title, { description })
  }

  function showSuccessToast(title: string, description: string) {
    toast.success(title, { description })
  }

  function showErrorToast(title: string, description: string) {
    toast.error(title, { description })
  }

  function logout(message = "已退出后台") {
    sessionStorage.removeItem("admin_token")
    setAuthenticated(false)
    setToken("")
    setTokenInput("")
    setOverview(null)
    setAdSlot(null)
    setTypes([])
    setInventory(null)
    setCodes(null)
    setRecords(null)
    setGeneratedCodes([])
    setSelectedInventoryIds([])
    setSelectedCodeIds([])
    showToast("会话已结束", message)
  }

  function handleApiError(error: unknown, title: string) {
    if (error instanceof ApiError && error.status === 401) {
      logout("登录状态已失效，请重新登录")
      return true
    }

    showErrorToast(title, formatErrorMessage(error))
    return false
  }

  async function copyText(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value)
      showSuccessToast("复制成功", `${label} 已复制到剪贴板`)
    } catch {
      showErrorToast("复制失败", "当前环境不支持自动复制，请手动复制")
    }
  }

  async function loadOverviewAndTypes(activeToken = token) {
    if (!activeToken) {
      return
    }

    setOverviewLoading(true)
    try {
      const [nextOverview, nextTypes] = await Promise.all([
        fetchAdminOverview(activeToken),
        fetchAdminTypes(activeToken),
      ])
      setOverview(nextOverview)
      setTypes(nextTypes)
      setDefaultTypeSelections(nextTypes)
    } catch (error) {
      handleApiError(error, "概览加载失败")
    } finally {
      setOverviewLoading(false)
    }
  }

  async function loadAds(activeToken = token) {
    if (!activeToken) {
      return
    }

    setAdsLoading(true)
    try {
      setAdSlot(await fetchAdminAds(activeToken))
    } catch (error) {
      handleApiError(error, "广告位配置加载失败")
    } finally {
      setAdsLoading(false)
    }
  }

  async function loadInventory(
    activeToken = token,
    overrides?: Partial<InventoryFilters>
  ) {
    if (!activeToken) {
      return
    }

    const nextFilters = {
      ...inventoryFilters,
      ...overrides,
    }
    setInventoryLoading(true)
    try {
      const nextInventory = await fetchAdminInventory(activeToken, {
        type_id: nextFilters.typeId,
        status: nextFilters.status,
        q: nextFilters.q,
        page: nextFilters.page,
        page_size: nextFilters.pageSize,
      })
      setInventoryFilters(nextFilters)
      setInventory(nextInventory)
    } catch (error) {
      handleApiError(error, "库存列表加载失败")
    } finally {
      setInventoryLoading(false)
    }
  }

  async function loadCodes(
    activeToken = token,
    overrides?: Partial<CodeFilters>
  ) {
    if (!activeToken) {
      return
    }

    const nextFilters = {
      ...codeFilters,
      ...overrides,
    }
    setCodesLoading(true)
    try {
      const nextCodes = await fetchAdminCodes(activeToken, {
        type_id: nextFilters.typeId,
        status: nextFilters.status,
        q: nextFilters.q,
        min_quantity: nextFilters.minQuantity,
        max_quantity: nextFilters.maxQuantity,
        page: nextFilters.page,
        page_size: nextFilters.pageSize,
      })
      setCodeFilters(nextFilters)
      setCodes(nextCodes)
    } catch (error) {
      handleApiError(error, "兑换码列表加载失败")
    } finally {
      setCodesLoading(false)
    }
  }

  async function loadRecords(
    activeToken = token,
    overrides?: Partial<RecordFilters>
  ) {
    if (!activeToken) {
      return
    }

    const nextFilters = {
      ...recordFilters,
      ...overrides,
    }
    setRecordsLoading(true)
    try {
      const nextRecords = await fetchAdminRecords(activeToken, {
        type_id: nextFilters.typeId,
        q: nextFilters.q,
        page: nextFilters.page,
        page_size: nextFilters.pageSize,
      })
      setRecordFilters(nextFilters)
      setRecords(nextRecords)
    } catch (error) {
      handleApiError(error, "兑换记录加载失败")
    } finally {
      setRecordsLoading(false)
    }
  }

  async function refreshDashboard(activeToken = token) {
    await Promise.all([
      loadOverviewAndTypes(activeToken),
      loadAds(activeToken),
      loadInventory(activeToken),
      loadCodes(activeToken),
      loadRecords(activeToken),
    ])
  }

  async function restoreSession(nextToken: string, silent = false) {
    setCheckingAuth(true)
    try {
      await verifyAdminToken(nextToken)
      sessionStorage.setItem("admin_token", nextToken)
      setAuthenticated(true)
      setToken(nextToken)
      setTokenInput(nextToken)
      if (!silent) {
        showSuccessToast("登录成功", "后台数据已经刷新完成。")
      }
      await refreshDashboard(nextToken)
    } catch (error) {
      sessionStorage.removeItem("admin_token")
      setAuthenticated(false)
      setToken("")
      if (!silent) {
        showErrorToast("登录失败", formatErrorMessage(error))
      }
    } finally {
      setCheckingAuth(false)
    }
  }

  useEffect(() => {
    const storedToken = sessionStorage.getItem("admin_token")
    if (!storedToken) {
      setCheckingAuth(false)
      return
    }

    void (async () => {
      setCheckingAuth(true)
      try {
        await verifyAdminToken(storedToken)
        const [
          nextOverview,
          nextAds,
          nextTypes,
          nextInventory,
          nextCodes,
          nextRecords,
        ] =
          await Promise.all([
            fetchAdminOverview(storedToken),
            fetchAdminAds(storedToken),
            fetchAdminTypes(storedToken),
            fetchAdminInventory(storedToken, {
              page: 1,
              page_size: 10,
            }),
            fetchAdminCodes(storedToken, {
              page: 1,
              page_size: 10,
            }),
            fetchAdminRecords(storedToken, {
              page: 1,
              page_size: 10,
            }),
          ])

        sessionStorage.setItem("admin_token", storedToken)
        setAuthenticated(true)
        setToken(storedToken)
        setTokenInput(storedToken)
        setOverview(nextOverview)
        setAdSlot(nextAds)
        setTypes(nextTypes)
        setInventory(nextInventory)
        setCodes(nextCodes)
        setRecords(nextRecords)

        const firstTypeId = nextTypes[0] ? String(nextTypes[0].id) : ""
        if (firstTypeId) {
          setInventoryImportTypeId((current) => current || firstTypeId)
          setGenerateTypeId((current) => current || firstTypeId)
        }
      } catch {
        sessionStorage.removeItem("admin_token")
        setAuthenticated(false)
        setToken("")
      } finally {
        setCheckingAuth(false)
      }
    })()
  }, [])

  async function handleLogin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextToken = tokenInput.trim()
    if (!nextToken) {
      showErrorToast("请输入管理令牌", "后台需要 Bearer Token 才能继续访问。")
      return
    }

    await restoreSession(nextToken)
  }

  function openCreateTypeDialog() {
    setEditingType(null)
    setTypeEditor(createTypeEditorState())
    setTypeDialogOpen(true)
  }

  function openEditTypeDialog(type: RedeemType) {
    setEditingType(type)
    setTypeEditor(createTypeEditorState(type))
    setTypeDialogOpen(true)
  }

  function openInventoryBatchEditDialog() {
    if (!selectedInventoryIds.length) {
      showErrorToast("请先选择库存", "批量编辑前需要至少勾选一条库存记录。")
      return
    }

    setInventoryBatchEdit({
      typeId: "",
      status: "",
    })
    setInventoryBatchEditDialogOpen(true)
  }

  function openCodeBatchEditDialog() {
    if (!selectedCodeIds.length) {
      showErrorToast("请先选择卡密", "批量编辑前需要至少勾选一个兑换码。")
      return
    }

    setCodeBatchEdit({
      typeId: "",
      quantity: "",
    })
    setCodeBatchEditDialogOpen(true)
  }

  function updateTypeField<K extends keyof TypeEditorState>(
    key: K,
    value: TypeEditorState[K]
  ) {
    setTypeEditor((current) => ({
      ...current,
      [key]: value,
    }))
  }

  function updateAdSlotField(
    key:
      | "title"
      | "description"
      | "image_url",
    value: string | string[]
  ) {
    setAdSlot((current) =>
      current
        ? {
            ...current,
            [key]: value,
          }
        : current
    )
  }

  function updateAdSlotEnabled(enabled: boolean) {
    setAdSlot((current) =>
      current
        ? {
            ...current,
            enabled,
          }
        : current
    )
  }

  function updateAdSlotActionField(
    actionKey: "primary_action",
    field: "label" | "href",
    value: string
  ) {
    setAdSlot((current) =>
      current
        ? {
            ...current,
            [actionKey]: {
              ...current[actionKey],
              [field]: value,
            },
          }
        : current
    )
  }

  async function handleAdSlotsSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!adSlot) {
      return
    }

    setAdsSubmitting(true)
    try {
      const payload = await updateAdminAds(token, adSlot)
      setAdSlot(payload.data)
      showSuccessToast("广告位已更新", payload.message)
    } catch (error) {
      handleApiError(error, "广告位配置更新失败")
    } finally {
      setAdsSubmitting(false)
    }
  }

  async function handleTypeSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setTypeSubmitting(true)
    try {
      if (editingType) {
        const payload = await updateAdminType(token, editingType.id, typeEditor)
        showSuccessToast("类型已更新", payload.message)
      } else {
        const payload = await createAdminType(token, typeEditor)
        showSuccessToast("类型已创建", payload.message)
      }
      setTypeDialogOpen(false)
      await loadOverviewAndTypes()
    } catch (error) {
      handleApiError(error, editingType ? "类型更新失败" : "类型创建失败")
    } finally {
      setTypeSubmitting(false)
    }
  }

  async function handleInventoryImport(
    event: React.FormEvent<HTMLFormElement>
  ) {
    event.preventDefault()
    if (!inventoryImportTypeId) {
      showErrorToast("请选择类型", "导入库存前需要指定一个兑换类型。")
      return
    }

    if (!inventoryImportText.trim()) {
      showErrorToast("请输入库存文本", "每行一条邮箱数据，按类型字段顺序导入。")
      return
    }

    setInventorySubmitting(true)
    try {
      const payload = await importAdminInventory(token, {
        type_id: Number(inventoryImportTypeId),
        mode: inventoryImportMode,
        text: inventoryImportText,
      })
      const parseErrors = payload.data.parse.errors.slice(0, 3).join("；")
      showSuccessToast(
        "库存导入完成",
        parseErrors
          ? `${payload.message}。部分错误：${parseErrors}`
          : payload.message
      )
      setInventoryImportDialogOpen(false)
      setInventoryImportText("")
      await Promise.all([
        loadOverviewAndTypes(),
        loadInventory(undefined, { page: 1 }),
      ])
    } catch (error) {
      handleApiError(error, "库存导入失败")
    } finally {
      setInventorySubmitting(false)
    }
  }

  async function handleCodeGenerate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!generateTypeId) {
      showErrorToast("请选择类型", "生成卡密前需要指定一个兑换类型。")
      return
    }

    setCodeSubmitting(true)
    try {
      const payload = await generateAdminCodes(token, {
        type_id: Number(generateTypeId),
        count: Number(generateCount || 1),
        quantity: Number(generateQuantity || 1),
        note: generateNote,
        expires_at: generateExpiresAt
          ? new Date(generateExpiresAt).toISOString()
          : undefined,
      })
      setGeneratedCodes(payload.data.items)
      showSuccessToast("卡密已生成", payload.message)
      await Promise.all([
        loadOverviewAndTypes(),
        loadCodes(undefined, { page: 1 }),
      ])
    } catch (error) {
      handleApiError(error, "生成卡密失败")
    } finally {
      setCodeSubmitting(false)
    }
  }

  function toggleSelectedInventory(inventoryId: number, checked: boolean) {
    setSelectedInventoryIds((current) => {
      const next = new Set(current)
      if (checked) {
        next.add(inventoryId)
      } else {
        next.delete(inventoryId)
      }
      return Array.from(next)
    })
  }

  function toggleSelectAllVisibleInventory(checked: boolean) {
    const visibleInventoryIds = (inventory?.items || []).map((item) => item.id)
    setSelectedInventoryIds((current) => {
      const next = new Set(current)
      for (const inventoryId of visibleInventoryIds) {
        if (checked) {
          next.add(inventoryId)
        } else {
          next.delete(inventoryId)
        }
      }
      return Array.from(next)
    })
  }

  async function handleDeleteInventory(inventoryId: number) {
    const confirmed = window.confirm(
      `确定删除库存记录 #${inventoryId} 吗？该操作会从库存列表中移除这条数据。`
    )
    if (!confirmed) {
      return
    }

    try {
      const payload = await deleteAdminInventory(token, inventoryId)
      showSuccessToast("库存记录已删除", payload.message)
      setSelectedInventoryIds((current) =>
        current.filter((item) => item !== inventoryId)
      )
      await Promise.all([loadOverviewAndTypes(), loadInventory()])
    } catch (error) {
      handleApiError(error, "删除库存失败")
    }
  }

  async function handleBatchDeleteInventory() {
    if (!selectedInventoryIds.length) {
      showErrorToast("请先选择库存", "批量删除前需要至少勾选一条库存记录。")
      return
    }

    const confirmed = window.confirm(
      `确定删除已选择的 ${selectedInventoryIds.length} 条库存记录吗？`
    )
    if (!confirmed) {
      return
    }

    try {
      const payload = await batchDeleteAdminInventory(
        token,
        selectedInventoryIds
      )
      showSuccessToast("批量删除完成", payload.message)
      setSelectedInventoryIds([])
      await Promise.all([
        loadOverviewAndTypes(),
        loadInventory(undefined, { page: 1 }),
      ])
    } catch (error) {
      handleApiError(error, "批量删除库存失败")
    }
  }

  async function handleExportSelectedInventory() {
    if (!selectedInventoryIds.length) {
      showErrorToast("请先选择库存", "导出前需要至少勾选一条库存记录。")
      return
    }

    try {
      const exported = await exportAdminInventoryText(
        token,
        selectedInventoryIds
      )
      downloadTextFile(exported.text, exported.filename)
      showSuccessToast(
        "导出成功",
        `已导出 ${selectedInventoryIds.length} 条库存记录。`
      )
    } catch (error) {
      handleApiError(error, "导出库存失败")
    }
  }

  async function handleInventoryBatchUpdate(
    event: React.FormEvent<HTMLFormElement>
  ) {
    event.preventDefault()
    if (!selectedInventoryIds.length) {
      showErrorToast("请先选择库存", "批量编辑前需要至少勾选一条库存记录。")
      return
    }

    const hasTypeId = Boolean(inventoryBatchEdit.typeId)
    const hasStatus = Boolean(inventoryBatchEdit.status)
    if (!hasTypeId && !hasStatus) {
      showErrorToast("未设置修改项", "请至少选择一个新的库存类型或可用状态。")
      return
    }

    setInventoryBatchSubmitting(true)
    try {
      const payload = await batchUpdateAdminInventory(token, {
        inventory_ids: selectedInventoryIds,
        ...(hasTypeId ? { type_id: Number(inventoryBatchEdit.typeId) } : {}),
        ...(hasStatus
          ? { status: inventoryBatchEdit.status as "available" | "unavailable" }
          : {}),
      })
      setInventoryBatchEditDialogOpen(false)
      setSelectedInventoryIds([])
      showSuccessToast("库存批量编辑完成", payload.message)
      await Promise.all([
        loadOverviewAndTypes(),
        loadInventory(undefined, { page: 1 }),
        loadRecords(),
      ])
    } catch (error) {
      handleApiError(error, "库存批量编辑失败")
    } finally {
      setInventoryBatchSubmitting(false)
    }
  }

  async function handleInventoryStatusChange(item: RedeemInventoryItem) {
    if (item.status === "redeemed") {
      showErrorToast("无法修改状态", "已兑换的库存记录不能再调整状态。")
      return
    }

    const nextStatus =
      item.status === "unavailable" ? "available" : "unavailable"
    const confirmed = window.confirm(
      nextStatus === "unavailable"
        ? `确定将库存 #${item.id} 设为不可用吗？设为不可用后，这条数据不会参与兑换。`
        : `确定将库存 #${item.id} 恢复为可用吗？恢复后，这条数据会重新参与兑换。`
    )
    if (!confirmed) {
      return
    }

    try {
      const payload = await updateAdminInventoryStatus(
        token,
        item.id,
        nextStatus
      )
      showSuccessToast("库存状态已更新", payload.message)
      await Promise.all([
        loadOverviewAndTypes(),
        loadInventory(),
        loadRecords(),
      ])
    } catch (error) {
      handleApiError(error, "库存状态更新失败")
    }
  }

  function toggleSelectedCode(codeId: number, checked: boolean) {
    setSelectedCodeIds((current) => {
      const next = new Set(current)
      if (checked) {
        next.add(codeId)
      } else {
        next.delete(codeId)
      }
      return Array.from(next)
    })
  }

  function toggleSelectAllVisibleCodes(checked: boolean) {
    const visibleCodeIds = (codes?.items || []).map((item) => item.id)
    setSelectedCodeIds((current) => {
      const next = new Set(current)
      for (const codeId of visibleCodeIds) {
        if (checked) {
          next.add(codeId)
        } else {
          next.delete(codeId)
        }
      }
      return Array.from(next)
    })
  }

  async function toggleCodeStatus(item: RedeemCodeItem) {
    try {
      const payload = await updateAdminCodeStatus(
        token,
        item.id,
        item.status === "disabled" ? "unused" : "disabled"
      )
      showSuccessToast("卡密状态已更新", payload.message)
      await Promise.all([loadOverviewAndTypes(), loadCodes(), loadRecords()])
    } catch (error) {
      handleApiError(error, "卡密状态更新失败")
    }
  }

  async function handleDeleteCode(item: RedeemCodeItem) {
    if (item.status === "redeemed") {
      showErrorToast("无法删除", "已兑换的卡密不能直接删除。")
      return
    }

    const confirmed = window.confirm(
      `确定删除卡密 #${item.id} 吗？该操作不可恢复。`
    )

    if (!confirmed) {
      return
    }

    try {
      const payload = await deleteAdminCode(token, item.id)
      showSuccessToast("卡密已删除", payload.message)
      setSelectedCodeIds((current) => current.filter((codeId) => codeId !== item.id))
      await Promise.all([loadOverviewAndTypes(), loadCodes(), loadRecords()])
    } catch (error) {
      handleApiError(error, "删除卡密失败")
    }
  }

  async function handleBatchCodeStatus(status: "unused" | "disabled") {
    if (!selectedCodeIds.length) {
      showErrorToast("请先选择卡密", "批量操作前需要至少勾选一个兑换码。")
      return
    }

    const actionText = status === "disabled" ? "禁用" : "恢复"
    const confirmed = window.confirm(
      `确定${actionText}已选择的 ${selectedCodeIds.length} 个兑换码吗？`
    )
    if (!confirmed) {
      return
    }

    try {
      const payload = await batchUpdateAdminCodeStatus(
        token,
        selectedCodeIds,
        status
      )
      showSuccessToast("卡密批量操作完成", payload.message)
      await Promise.all([loadOverviewAndTypes(), loadCodes(), loadRecords()])
    } catch (error) {
      handleApiError(error, "卡密批量状态更新失败")
    }
  }

  async function handleBatchDeleteCodes() {
    if (!selectedCodeIds.length) {
      showErrorToast("请先选择卡密", "批量删除前需要至少勾选一个兑换码。")
      return
    }

    const confirmed = window.confirm(
      `确定删除已选择的 ${selectedCodeIds.length} 个兑换码吗？已兑换卡密会自动跳过。`
    )
    if (!confirmed) {
      return
    }

    try {
      const payload = await batchDeleteAdminCodes(token, selectedCodeIds)
      showSuccessToast("批量删除完成", payload.message)
      setSelectedCodeIds([])
      await Promise.all([
        loadOverviewAndTypes(),
        loadCodes(undefined, { page: 1 }),
        loadRecords(),
      ])
    } catch (error) {
      handleApiError(error, "批量删除卡密失败")
    }
  }

  async function handleCodeBatchUpdate(
    event: React.FormEvent<HTMLFormElement>
  ) {
    event.preventDefault()
    if (!selectedCodeIds.length) {
      showErrorToast("请先选择卡密", "批量编辑前需要至少勾选一个兑换码。")
      return
    }

    const hasTypeId = Boolean(codeBatchEdit.typeId)
    const quantityText = codeBatchEdit.quantity.trim()
    const hasQuantity = Boolean(quantityText)
    if (!hasTypeId && !hasQuantity) {
      showErrorToast("未设置修改项", "请至少选择一个新的类型或可兑数量。")
      return
    }

    if (hasQuantity) {
      const parsedQuantity = Number(quantityText)
      if (
        !Number.isInteger(parsedQuantity) ||
        parsedQuantity < 1 ||
        parsedQuantity > 500
      ) {
        showErrorToast("数量不合法", "卡密可兑数量需为 1 到 500 的整数。")
        return
      }
    }

    setCodeBatchSubmitting(true)
    try {
      const payload = await batchUpdateAdminCodes(token, {
        code_ids: selectedCodeIds,
        ...(hasTypeId ? { type_id: Number(codeBatchEdit.typeId) } : {}),
        ...(hasQuantity ? { quantity: Number(quantityText) } : {}),
      })
      setCodeBatchEditDialogOpen(false)
      setSelectedCodeIds([])
      showSuccessToast("卡密批量编辑完成", payload.message)
      await Promise.all([
        loadOverviewAndTypes(),
        loadCodes(undefined, { page: 1 }),
        loadRecords(),
      ])
    } catch (error) {
      handleApiError(error, "卡密批量编辑失败")
    } finally {
      setCodeBatchSubmitting(false)
    }
  }

  async function handleExportSelectedCodes() {
    if (!selectedCodeIds.length) {
      showErrorToast("请先选择卡密", "导出前需要至少勾选一个兑换码。")
      return
    }

    try {
      const exported = await exportAdminCodesText(token, {
        code_ids: selectedCodeIds,
      })
      downloadTextFile(exported.text, exported.filename)
      showSuccessToast(
        "导出成功",
        `已导出 ${selectedCodeIds.length} 个兑换码。`
      )
    } catch (error) {
      handleApiError(error, "导出卡密失败")
    }
  }

  async function handleExportFilteredCodes() {
    try {
      const exported = await exportAdminCodesText(token, {
        type_id: codeFilters.typeId,
        status: codeFilters.status,
        q: codeFilters.q,
        min_quantity: codeFilters.minQuantity,
        max_quantity: codeFilters.maxQuantity,
      })
      downloadTextFile(exported.text, exported.filename)
      showSuccessToast(
        "导出成功",
        `已按当前筛选条件导出${codeFilters.status ? `「${codeFilters.status}」状态的` : ""}兑换码。`
      )
    } catch (error) {
      handleApiError(error, "按筛选导出卡密失败")
    }
  }

  async function handleImportFileSelection(
    file: File | undefined,
    setter: (value: string) => void,
    label: string
  ) {
    if (!file) {
      return
    }

    try {
      const content = await readTextFile(file)
      setter(content)
      showSuccessToast(
        "文件已加载",
        `${label}文件 ${file.name} 已填充到导入框。`
      )
    } catch {
      showErrorToast(
        "读取失败",
        `无法读取 ${file.name}，请检查文件编码或重新选择。`
      )
    }
  }

  async function handlePasswordUpdate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!passwordForm.currentToken.trim() || !passwordForm.newToken.trim()) {
      showErrorToast("请填写完整密码信息", "当前密码和新密码都不能为空。")
      return
    }

    setPasswordSubmitting(true)
    try {
      const payload = await updateAdminPassword(token, {
        current_token: passwordForm.currentToken.trim(),
        new_token: passwordForm.newToken.trim(),
      })
      setToken(payload.data.token)
      setTokenInput(payload.data.token)
      sessionStorage.setItem("admin_token", payload.data.token)
      setPasswordForm({
        currentToken: "",
        newToken: "",
      })
      setPasswordDialogOpen(false)
      showSuccessToast("管理密码已更新", payload.message)
    } catch (error) {
      handleApiError(error, "管理密码修改失败")
    } finally {
      setPasswordSubmitting(false)
    }
  }

  async function openRecordDetail(codeId: number) {
    setRecordDetailDialogOpen(true)
    setRecordDetailLoading(true)

    try {
      const detail = await fetchAdminRecordDetail(token, codeId)
      setRecordDetail(detail)
    } catch (error) {
      setRecordDetail(null)
      handleApiError(error, "兑换记录详情加载失败")
      setRecordDetailDialogOpen(false)
    } finally {
      setRecordDetailLoading(false)
    }
  }

  function handleDownloadRecordDetail() {
    if (!recordDetail) {
      return
    }

    downloadTextFile(
      recordDetail.items.map((item) => recordLine(item)).join("\n"),
      createTextExportFilename("redeem_record", recordDetail.code)
    )
    showSuccessToast(
      "下载成功",
      `已下载 ${recordDetail.item_count} 条兑换记录。`
    )
  }

  const visibleInventoryIds = (inventory?.items || []).map((item) => item.id)
  const selectedInventorySet = new Set(selectedInventoryIds)
  const selectedVisibleInventoryCount = visibleInventoryIds.filter((id) =>
    selectedInventorySet.has(id)
  ).length
  const allVisibleInventorySelected =
    visibleInventoryIds.length > 0 &&
    selectedVisibleInventoryCount === visibleInventoryIds.length
  const visibleCodeIds = (codes?.items || []).map((item) => item.id)
  const selectedCodeSet = new Set(selectedCodeIds)
  const selectedVisibleCodeCount = visibleCodeIds.filter((id) =>
    selectedCodeSet.has(id)
  ).length
  const allVisibleCodesSelected =
    visibleCodeIds.length > 0 &&
    selectedVisibleCodeCount === visibleCodeIds.length
  const visibleRecordDetailItems =
    recordDetail?.items.slice(0, MAX_RECORD_PREVIEW_ITEMS) || []
  const hiddenRecordDetailCount = recordDetail
    ? Math.max(0, recordDetail.items.length - MAX_RECORD_PREVIEW_ITEMS)
    : 0

  if (checkingAuth) {
    return (
      <main className="page-shell page-shell-admin min-h-svh">
        <div className="mx-auto flex min-h-svh max-w-7xl items-center justify-center px-4 py-10">
          <Card className="w-full max-w-md border border-border/70 bg-card/90 backdrop-blur">
            <CardHeader className="border-b border-border/70">
              <CardTitle>正在恢复后台会话</CardTitle>
              <CardDescription>
                如果浏览器里保存过管理令牌，会自动完成登录。
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </CardContent>
          </Card>
        </div>
      </main>
    )
  }

  if (!authenticated) {
    return (
      <main className="page-shell page-shell-admin min-h-svh">
        <div className="mx-auto flex min-h-svh max-w-7xl items-center justify-center px-4 py-10">
          <Card className="w-full max-w-md border border-border/70 bg-card/90 backdrop-blur">
            <CardHeader className="border-b border-border/70">
              <CardTitle>兑换后台登录</CardTitle>
              <CardDescription>
                使用当前 Express
                后端的管理令牌登录，进入统一的账号与兑换工作台。
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              <form className="flex flex-col gap-5" onSubmit={handleLogin}>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="admin-token">管理令牌</FieldLabel>
                    <FieldContent>
                      <Input
                        id="admin-token"
                        type="password"
                        autoComplete="current-password"
                        value={tokenInput}
                        onChange={(event) => setTokenInput(event.target.value)}
                        placeholder="输入 Bearer Token"
                      />
                      <FieldDescription>
                        当前后台已经整合了账号管理和卡密兑换管理能力。
                      </FieldDescription>
                    </FieldContent>
                  </Field>
                </FieldGroup>
                <Button type="submit" size="lg">
                  <ShieldIcon data-icon="inline-start" />
                  进入后台
                </Button>
              </form>

              <Separator />

              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" asChild>
                  <a href="/redeem">
                    <TicketIcon data-icon="inline-start" />
                    返回兑换页
                  </a>
                </Button>
                <Button variant="outline" size="sm" asChild>
                  <a href="/mail">
                    <MailIcon data-icon="inline-start" />
                    收件页
                  </a>
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
    )
  }

  return (
    <main className="page-shell page-shell-admin relative min-h-svh overflow-hidden">
      <div className="redeem-noise pointer-events-none absolute inset-0 opacity-60" />
      <div className="relative mx-auto flex min-h-svh w-full max-w-7xl flex-col gap-6 px-4 py-6 md:px-6 lg:px-8">
        <header className="flex flex-col gap-2 border-b border-border/70 pb-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-heading text-xl font-medium tracking-tight md:text-2xl">
                Admin Console
              </h1>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {overviewLoading || !overview ? (
                Array.from({ length: 5 }).map((_, index) => (
                  <Skeleton key={index} className="h-5 w-16" />
                ))
              ) : (
                <>
                  <Badge variant="outline">类型 {overview.type_count}</Badge>
                  <Badge variant="outline">
                    库存 {overview.total_inventory_count}
                  </Badge>
                  <Badge variant="outline">
                    可用 {overview.available_inventory_count}
                  </Badge>
                  <Badge variant="outline">
                    不可用 {overview.unavailable_inventory_count}
                  </Badge>
                  <Badge variant="outline">
                    卡密 {overview.unused_code_count}
                  </Badge>
                  <Badge variant="outline">记录 {overview.record_count}</Badge>
                </>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <ThemeToggle />
            <Button
              variant="outline"
              size="sm"
              onClick={() => void refreshDashboard()}
              className="hidden md:inline-flex"
            >
              <RefreshCcwIcon data-icon="inline-start" />
              刷新数据
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPasswordDialogOpen(true)}
              className="hidden md:inline-flex"
            >
              <UserCogIcon data-icon="inline-start" />
              修改密码
            </Button>
            <Button
              variant="outline"
              size="sm"
              asChild
              className="hidden md:inline-flex"
            >
              <a href="/redeem">
                <TicketIcon data-icon="inline-start" />
                用户兑换页
              </a>
            </Button>
            <Button
              variant="outline"
              size="sm"
              asChild
              className="hidden md:inline-flex"
            >
              <a href="/mail">
                <MailIcon data-icon="inline-start" />
                收件页
              </a>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => logout()}
              className="hidden md:inline-flex"
            >
              <LogOutIcon data-icon="inline-start" />
              退出
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="md:hidden">
                  <EllipsisVerticalIcon data-icon="inline-start" />
                  更多
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => void refreshDashboard()}>
                  刷新数据
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setPasswordDialogOpen(true)}>
                  修改密码
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <a href="/redeem">用户兑换页</a>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <a href="/mail">收件页</a>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => logout()}>
                  退出
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <div className="overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <TabsList variant="line" className="min-w-max">
              <TabsTrigger value="types">
                <Layers3Icon />
                类型管理
              </TabsTrigger>
              <TabsTrigger value="inventory">
                <PackagePlusIcon />
                库存管理
              </TabsTrigger>
              <TabsTrigger value="codes">
                <KeyRoundIcon />
                卡密管理
              </TabsTrigger>
              <TabsTrigger value="ads">
                <TicketIcon />
                广告位
              </TabsTrigger>
              <TabsTrigger value="records">
                <EyeIcon />
                兑换记录
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="types">
            <div className="flex flex-col gap-4">
              <Card className="border border-border/70 bg-card/88 backdrop-blur">
                <CardHeader className="border-b border-border/70">
                  <CardAction>
                    <Button size="sm" onClick={openCreateTypeDialog}>
                      <PlusIcon data-icon="inline-start" />
                      新增类型
                    </Button>
                  </CardAction>
                  <CardTitle>兑换类型</CardTitle>
                  <CardDescription>
                    <div className="flex flex-wrap items-center gap-2">
                      <span>类型只定义整行数据类别，不再区分字段结构。</span>
                      <Badge variant="outline">类型 {types.length}</Badge>
                      <Badge variant="outline">
                        可用库存 {overview?.available_inventory_count || 0}
                      </Badge>
                      <Badge variant="outline">
                        可用卡密 {overview?.unused_code_count || 0}
                      </Badge>
                    </div>
                  </CardDescription>
                </CardHeader>
                <CardContent className="px-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="px-4">类型</TableHead>
                        <TableHead>数据模式</TableHead>
                        <TableHead>库存 / 卡密</TableHead>
                        <TableHead>状态</TableHead>
                        <TableHead className="px-4 text-right">操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {types.map((type) => (
                        <TableRow key={type.id}>
                          <TableCell className="px-4 align-top">
                            <div className="flex flex-col gap-1">
                              <span className="font-medium">{type.name}</span>
                              <span className="font-mono text-[11px] text-muted-foreground">
                                {type.slug}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell className="align-top">
                            <Badge variant="outline">整行数据</Badge>
                          </TableCell>
                          <TableCell className="align-top">
                            <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                              <span>库存 {type.available_inventory_count}</span>
                              <span>卡密 {type.available_code_count}</span>
                              <span>已兑换 {type.redeemed_count}</span>
                            </div>
                          </TableCell>
                          <TableCell className="align-top">
                            <Badge
                              variant={type.is_active ? "secondary" : "outline"}
                            >
                              {type.is_active ? "启用中" : "已停用"}
                            </Badge>
                          </TableCell>
                          <TableCell className="px-4 text-right align-top">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => openEditTypeDialog(type)}
                            >
                              编辑
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="inventory">
            <Card className="border border-border/70 bg-card/88 backdrop-blur">
              <CardHeader className="border-b border-border/70">
                <CardAction className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    onClick={() => setInventoryImportDialogOpen(true)}
                  >
                    <PackagePlusIcon data-icon="inline-start" />
                    导入库存
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm">
                        批量操作
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuLabel>
                        已选 {selectedInventoryIds.length} 条库存
                      </DropdownMenuLabel>
                      <DropdownMenuGroup>
                        <DropdownMenuItem
                          onSelect={openInventoryBatchEditDialog}
                        >
                          批量编辑
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => {
                            void handleExportSelectedInventory()
                          }}
                        >
                          导出已选
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() => {
                            void handleBatchDeleteInventory()
                          }}
                        >
                          批量删除
                        </DropdownMenuItem>
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </CardAction>
                <CardTitle>库存列表</CardTitle>
                <CardDescription>
                  <div className="flex flex-wrap items-center gap-2">
                    <span>
                      查看当前库存状态，支持按类型和关键字筛选，也支持批量修改类型和可用状态。
                    </span>
                    <Badge variant="outline">
                      总量 {overview?.total_inventory_count || 0}
                    </Badge>
                    <Badge variant="outline">
                      可用 {overview?.available_inventory_count || 0}
                    </Badge>
                    <Badge variant="outline">
                      不可用 {overview?.unavailable_inventory_count || 0}
                    </Badge>
                    <Badge variant="outline">
                      已兑换 {overview?.redeemed_inventory_count || 0}
                    </Badge>
                    <Badge variant="outline">
                      已选 {selectedInventoryIds.length}
                    </Badge>
                  </div>
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4 px-0">
                <form
                  className="flex flex-col gap-4 px-4"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void loadInventory(undefined, { page: 1 })
                  }}
                >
                  <div className="grid gap-3 md:grid-cols-[1fr_1fr_1.5fr_auto]">
                    <Select
                      value={inventoryFilters.typeId || "all"}
                      onValueChange={(value) =>
                        setInventoryFilters((current) => ({
                          ...current,
                          typeId: value === "all" ? "" : value,
                        }))
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="全部类型" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="all">全部类型</SelectItem>
                          {types.map((type) => (
                            <SelectItem key={type.id} value={String(type.id)}>
                              {type.name}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <Select
                      value={inventoryFilters.status || "all"}
                      onValueChange={(value) =>
                        setInventoryFilters((current) => ({
                          ...current,
                          status: value === "all" ? "" : value,
                        }))
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="全部状态" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="all">全部状态</SelectItem>
                          <SelectItem value="available">可用</SelectItem>
                          <SelectItem value="unavailable">不可用</SelectItem>
                          <SelectItem value="redeemed">已兑换</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <Input
                      value={inventoryFilters.q}
                      onChange={(event) =>
                        setInventoryFilters((current) => ({
                          ...current,
                          q: event.target.value,
                        }))
                      }
                      placeholder="搜索账号、Token 或整行内容"
                    />
                    <Button type="submit">
                      <SearchIcon data-icon="inline-start" />
                      查询
                    </Button>
                  </div>
                </form>

                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-12 px-4">
                        <input
                          type="checkbox"
                          checked={allVisibleInventorySelected}
                          ref={(node) => {
                            if (node) {
                              node.indeterminate =
                                selectedVisibleInventoryCount > 0 &&
                                !allVisibleInventorySelected
                            }
                          }}
                          onChange={(event) =>
                            toggleSelectAllVisibleInventory(
                              event.currentTarget.checked
                            )
                          }
                        />
                      </TableHead>
                      <TableHead className="px-4">类型</TableHead>
                      <TableHead>库存内容</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>更新时间</TableHead>
                      <TableHead className="px-4 text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {inventoryLoading ? (
                      Array.from({ length: 4 }).map((_, index) => (
                        <TableRow key={index}>
                          <TableCell className="px-4">
                            <Skeleton className="size-4" />
                          </TableCell>
                          <TableCell className="px-4">
                            <Skeleton className="h-4 w-24" />
                          </TableCell>
                          <TableCell>
                            <Skeleton className="h-4 w-full" />
                          </TableCell>
                          <TableCell>
                            <Skeleton className="h-4 w-16" />
                          </TableCell>
                          <TableCell>
                            <Skeleton className="h-4 w-24" />
                          </TableCell>
                          <TableCell className="px-4">
                            <Skeleton className="ml-auto h-7 w-16" />
                          </TableCell>
                        </TableRow>
                      ))
                    ) : inventory?.items.length ? (
                      inventory.items.map((item) => (
                        <TableRow key={item.id}>
                          <TableCell className="px-4 align-top">
                            <input
                              type="checkbox"
                              checked={selectedInventorySet.has(item.id)}
                              onChange={(event) =>
                                toggleSelectedInventory(
                                  item.id,
                                  event.currentTarget.checked
                                )
                              }
                            />
                          </TableCell>
                          <TableCell className="px-4 align-top">
                            <div className="flex flex-col gap-1">
                              <span className="font-medium">
                                {item.type_name}
                              </span>
                              <span className="font-mono text-[11px] text-muted-foreground">
                                #{item.id}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell className="max-w-xl align-top">
                            <div className="flex items-center gap-2">
                              <code className="truncate text-xs">
                                {truncateText(item.serialized_value, 88)}
                              </code>
                              <Button
                                variant="outline"
                                size="xs"
                                onClick={() =>
                                  void copyText(
                                    item.serialized_value,
                                    "库存整行内容"
                                  )
                                }
                              >
                                <CopyIcon data-icon="inline-start" />
                                复制
                              </Button>
                            </div>
                          </TableCell>
                          <TableCell className="align-top">
                            <Badge
                              variant={
                                item.status === "available"
                                  ? "secondary"
                                  : "outline"
                              }
                            >
                              {inventoryStatusLabel(item.status)}
                            </Badge>
                          </TableCell>
                          <TableCell className="align-top text-muted-foreground">
                            {formatDateTime(item.updated_at)}
                          </TableCell>
                          <TableCell className="px-4 text-right align-top">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="outline"
                                  size="icon-xs"
                                  aria-label={`库存 #${item.id} 操作`}
                                >
                                  <EllipsisVerticalIcon />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent
                                align="end"
                                className="w-44 min-w-44"
                              >
                                <DropdownMenuLabel>
                                  库存 #{item.id}
                                </DropdownMenuLabel>
                                <DropdownMenuGroup>
                                  <DropdownMenuItem
                                    onSelect={() => {
                                      void copyText(
                                        item.serialized_value,
                                        "库存整行内容"
                                      )
                                    }}
                                  >
                                    复制库存内容
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    disabled={item.status === "redeemed"}
                                    onSelect={() => {
                                      void handleInventoryStatusChange(item)
                                    }}
                                  >
                                    {item.status === "redeemed"
                                      ? "已完成兑换"
                                      : item.status === "unavailable"
                                        ? "恢复可用"
                                        : "设为不可用"}
                                  </DropdownMenuItem>
                                </DropdownMenuGroup>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  variant="destructive"
                                  onSelect={() => {
                                    void handleDeleteInventory(item.id)
                                  }}
                                >
                                  删除库存
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell
                          className="px-4 text-muted-foreground"
                          colSpan={6}
                        >
                          当前没有匹配的库存记录。
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>

                <SectionPager
                  page={inventory?.page || inventoryFilters.page}
                  pageSize={inventory?.page_size || 10}
                  total={inventory?.total || 0}
                  onPageChange={(page) =>
                    void loadInventory(undefined, { page })
                  }
                  onPageSizeChange={(pageSize) =>
                    void loadInventory(undefined, { page: 1, pageSize })
                  }
                  onPrev={() =>
                    void loadInventory(undefined, {
                      page: Math.max(1, inventoryFilters.page - 1),
                    })
                  }
                  onNext={() =>
                    void loadInventory(undefined, {
                      page: inventoryFilters.page + 1,
                    })
                  }
                />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="codes">
            <Card className="border border-border/70 bg-card/88 backdrop-blur">
              <CardHeader className="border-b border-border/70">
                <CardAction className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    onClick={() => {
                      setGeneratedCodes([])
                      setCodeGenerateDialogOpen(true)
                    }}
                  >
                    <KeyRoundIcon data-icon="inline-start" />
                    生成卡密
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm">
                        批量操作
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuLabel>
                        已选 {selectedCodeIds.length} 个兑换码
                      </DropdownMenuLabel>
                      <DropdownMenuGroup>
                        <DropdownMenuItem onSelect={openCodeBatchEditDialog}>
                          批量编辑
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => {
                            void handleBatchDeleteCodes()
                          }}
                        >
                          批量删除已选
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => {
                            void handleBatchCodeStatus("disabled")
                          }}
                        >
                          批量禁用已选
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => {
                            void handleBatchCodeStatus("unused")
                          }}
                        >
                          批量恢复已选
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => {
                            void handleExportSelectedCodes()
                          }}
                        >
                          导出已选
                        </DropdownMenuItem>
                      </DropdownMenuGroup>
                      <DropdownMenuSeparator />
                      <DropdownMenuGroup>
                        <DropdownMenuItem
                          onSelect={() => {
                            void handleExportFilteredCodes()
                          }}
                        >
                          按当前筛选导出
                        </DropdownMenuItem>
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </CardAction>
                <CardTitle>卡密列表</CardTitle>
                <CardDescription>
                  <div className="flex flex-wrap items-center gap-2">
                    <span>
                      支持按状态与可兑数量筛选、单删批删、批量修改类型和可兑数量，并可导出纯卡密文本。
                    </span>
                    <Badge variant="outline">
                      总量 {overview?.total_code_count || 0}
                    </Badge>
                    <Badge variant="outline">
                      可用 {overview?.unused_code_count || 0}
                    </Badge>
                    <Badge variant="outline">
                      已兑换 {overview?.redeemed_code_count || 0}
                    </Badge>
                    <Badge variant="outline">
                      已禁用 {overview?.disabled_code_count || 0}
                    </Badge>
                    <Badge variant="outline">
                      已选 {selectedCodeIds.length}
                    </Badge>
                  </div>
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4 px-0">
                <form
                  className="flex flex-col gap-4 px-4"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void loadCodes(undefined, { page: 1 })
                  }}
                >
                  <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4 xl:grid-cols-[1fr_1fr_1.4fr_1fr_1fr_auto]">
                    <Select
                      value={codeFilters.typeId || "all"}
                      onValueChange={(value) =>
                        setCodeFilters((current) => ({
                          ...current,
                          typeId: value === "all" ? "" : value,
                        }))
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="全部类型" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="all">全部类型</SelectItem>
                          {types.map((type) => (
                            <SelectItem key={type.id} value={String(type.id)}>
                              {type.name}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <Select
                      value={codeFilters.status || "all"}
                      onValueChange={(value) =>
                        setCodeFilters((current) => ({
                          ...current,
                          status: value === "all" ? "" : value,
                        }))
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="全部状态" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="all">全部状态</SelectItem>
                          <SelectItem value="available">可用</SelectItem>
                          <SelectItem value="unused">未使用</SelectItem>
                          <SelectItem value="redeemed">已兑换</SelectItem>
                          <SelectItem value="disabled">已禁用</SelectItem>
                          <SelectItem value="expired">已过期</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <Input
                      value={codeFilters.q}
                      onChange={(event) =>
                        setCodeFilters((current) => ({
                          ...current,
                          q: event.target.value,
                        }))
                      }
                      placeholder="搜索卡密"
                    />
                    <Input
                      inputMode="numeric"
                      value={codeFilters.minQuantity}
                      onChange={(event) =>
                        setCodeFilters((current) => ({
                          ...current,
                          minQuantity: event.target.value.replace(/[^\d]/g, ""),
                        }))
                      }
                      placeholder="最小可兑数量"
                    />
                    <Input
                      inputMode="numeric"
                      value={codeFilters.maxQuantity}
                      onChange={(event) =>
                        setCodeFilters((current) => ({
                          ...current,
                          maxQuantity: event.target.value.replace(/[^\d]/g, ""),
                        }))
                      }
                      placeholder="最大可兑数量"
                    />
                    <Button type="submit">
                      <SearchIcon data-icon="inline-start" />
                      查询
                    </Button>
                  </div>
                </form>

                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-12 px-4">
                        <input
                          type="checkbox"
                          checked={allVisibleCodesSelected}
                          ref={(node) => {
                            if (node) {
                              node.indeterminate =
                                selectedVisibleCodeCount > 0 &&
                                !allVisibleCodesSelected
                            }
                          }}
                          onChange={(event) =>
                            toggleSelectAllVisibleCodes(
                              event.currentTarget.checked
                            )
                          }
                        />
                      </TableHead>
                      <TableHead className="px-4">卡密</TableHead>
                      <TableHead>类型</TableHead>
                      <TableHead>可兑数量</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>过期时间</TableHead>
                      <TableHead className="px-4 text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {codesLoading ? (
                      Array.from({ length: 4 }).map((_, index) => (
                        <TableRow key={index}>
                          <TableCell className="px-4">
                            <Skeleton className="size-4" />
                          </TableCell>
                          <TableCell className="px-4">
                            <Skeleton className="h-4 w-28" />
                          </TableCell>
                          <TableCell>
                            <Skeleton className="h-4 w-20" />
                          </TableCell>
                          <TableCell>
                            <Skeleton className="h-4 w-16" />
                          </TableCell>
                          <TableCell>
                            <Skeleton className="h-4 w-16" />
                          </TableCell>
                          <TableCell>
                            <Skeleton className="h-4 w-24" />
                          </TableCell>
                          <TableCell className="px-4">
                            <Skeleton className="ml-auto h-7 w-16" />
                          </TableCell>
                        </TableRow>
                      ))
                    ) : codes?.items.length ? (
                      codes.items.map((item) => (
                        <TableRow key={item.id}>
                          <TableCell className="px-4 align-top">
                            <input
                              type="checkbox"
                              checked={selectedCodeSet.has(item.id)}
                              onChange={(event) =>
                                toggleSelectedCode(
                                  item.id,
                                  event.currentTarget.checked
                                )
                              }
                            />
                          </TableCell>
                          <TableCell className="px-4 align-top">
                            <div className="flex items-center gap-2">
                              <code className="font-mono text-xs">
                                {item.code}
                              </code>
                              <Button
                                variant="outline"
                                size="xs"
                                onClick={() =>
                                  void copyText(item.code, "兑换码")
                                }
                              >
                                <CopyIcon data-icon="inline-start" />
                                复制
                              </Button>
                            </div>
                          </TableCell>
                          <TableCell className="align-top">
                            {item.type_name}
                          </TableCell>
                          <TableCell className="align-top">
                            <div className="flex flex-col gap-1 text-xs">
                              <Badge variant="outline">
                                总量 {item.quantity}
                              </Badge>
                              <span className="text-muted-foreground">
                                已兑 {item.redeemed_quantity} · 剩余{" "}
                                {item.remaining_quantity}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell className="align-top">
                            <Badge
                              variant={
                                item.derived_status === "unused"
                                  ? "secondary"
                                  : "outline"
                              }
                            >
                              {codeStatusLabel(item.derived_status)}
                            </Badge>
                          </TableCell>
                          <TableCell className="align-top text-muted-foreground">
                            {formatDateTime(item.expires_at)}
                          </TableCell>
                          <TableCell className="px-4 text-right align-top">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="outline"
                                  size="icon-xs"
                                  aria-label={`卡密 #${item.id} 操作`}
                                >
                                  <EllipsisVerticalIcon />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent
                                align="end"
                                className="w-44 min-w-44"
                              >
                                <DropdownMenuLabel>
                                  卡密 #{item.id}
                                </DropdownMenuLabel>
                                <DropdownMenuGroup>
                                  <DropdownMenuItem
                                    onSelect={() => {
                                      void copyText(item.code, "兑换码")
                                    }}
                                  >
                                    复制卡密
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    disabled={item.status === "redeemed"}
                                    onSelect={() => {
                                      void toggleCodeStatus(item)
                                    }}
                                  >
                                    {item.status === "redeemed"
                                      ? "已使用"
                                      : item.status === "disabled"
                                        ? "恢复可用"
                                        : "设为禁用"}
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    disabled={item.status === "redeemed"}
                                    onSelect={() => {
                                      void handleDeleteCode(item)
                                    }}
                                  >
                                    删除卡密
                                  </DropdownMenuItem>
                                </DropdownMenuGroup>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell
                          className="px-4 text-muted-foreground"
                          colSpan={7}
                        >
                          当前没有匹配的兑换码。
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>

                <SectionPager
                  page={codes?.page || codeFilters.page}
                  pageSize={codes?.page_size || 10}
                  total={codes?.total || 0}
                  onPageChange={(page) => void loadCodes(undefined, { page })}
                  onPageSizeChange={(pageSize) =>
                    void loadCodes(undefined, { page: 1, pageSize })
                  }
                  onPrev={() =>
                    void loadCodes(undefined, {
                      page: Math.max(1, codeFilters.page - 1),
                    })
                  }
                  onNext={() =>
                    void loadCodes(undefined, { page: codeFilters.page + 1 })
                  }
                />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="ads">
            <Card className="border border-border/70 bg-card/88 backdrop-blur">
              <CardHeader className="border-b border-border/70">
                <CardAction>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void loadAds()}
                    disabled={adsLoading}
                  >
                    <RefreshCcwIcon data-icon="inline-start" />
                    刷新广告位
                  </Button>
                </CardAction>
                <CardTitle>广告位配置</CardTitle>
                <CardDescription>
                  配置兑换页和收件页的自营商品推荐卡内容。建议直接写你发卡网的商品和入口，不要堆太多标签或复杂营销话术。
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-5">
                {adsLoading && !adSlot ? (
                  <Skeleton className="h-96 w-full" />
                ) : adSlot ? (
                  <form className="flex flex-col gap-5" onSubmit={handleAdSlotsSubmit}>
                    <AdSlotEditorCard
                      slot={adSlot}
                      onEnabledChange={updateAdSlotEnabled}
                      onFieldChange={updateAdSlotField}
                      onActionChange={updateAdSlotActionField}
                    />
                    <div className="flex justify-end">
                      <Button type="submit" disabled={adsSubmitting}>
                        {adsSubmitting ? "保存中..." : "保存广告位"}
                      </Button>
                    </div>
                  </form>
                ) : (
                  <div className="text-sm text-muted-foreground">
                    当前未加载到广告位配置。
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="records">
            <Card className="border border-border/70 bg-card/88 backdrop-blur">
              <CardHeader className="border-b border-border/70">
                <CardTitle>兑换记录</CardTitle>
                <CardDescription>
                  <div className="flex flex-wrap items-center gap-2">
                    <span>
                      核查用户实际领取到的数据，也可以用于排查库存与卡密批次。
                    </span>
                    <Badge variant="outline">
                      记录 {overview?.record_count || 0}
                    </Badge>
                  </div>
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4 px-0">
                <form
                  className="flex flex-col gap-4 px-4"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void loadRecords(undefined, { page: 1 })
                  }}
                >
                  <div className="grid gap-3 md:grid-cols-[1fr_1.6fr_auto]">
                    <Select
                      value={recordFilters.typeId || "all"}
                      onValueChange={(value) =>
                        setRecordFilters((current) => ({
                          ...current,
                          typeId: value === "all" ? "" : value,
                        }))
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="全部类型" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="all">全部类型</SelectItem>
                          {types.map((type) => (
                            <SelectItem key={type.id} value={String(type.id)}>
                              {type.name}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <Input
                      value={recordFilters.q}
                      onChange={(event) =>
                        setRecordFilters((current) => ({
                          ...current,
                          q: event.target.value,
                        }))
                      }
                      placeholder="搜索卡密或账号关键字"
                    />
                    <Button type="submit">
                      <SearchIcon data-icon="inline-start" />
                      查询
                    </Button>
                  </div>
                </form>

                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="px-4">时间</TableHead>
                      <TableHead>类型</TableHead>
                      <TableHead>卡密</TableHead>
                      <TableHead>发放数量</TableHead>
                      <TableHead className="px-4 text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {recordsLoading ? (
                      Array.from({ length: 4 }).map((_, index) => (
                        <TableRow key={index}>
                          <TableCell className="px-4">
                            <Skeleton className="h-4 w-32" />
                          </TableCell>
                          <TableCell>
                            <Skeleton className="h-4 w-20" />
                          </TableCell>
                          <TableCell>
                            <Skeleton className="h-4 w-24" />
                          </TableCell>
                          <TableCell>
                            <Skeleton className="h-4 w-16" />
                          </TableCell>
                          <TableCell className="px-4">
                            <Skeleton className="ml-auto h-7 w-16" />
                          </TableCell>
                        </TableRow>
                      ))
                    ) : records?.items.length ? (
                      records.items.map((item) => (
                        <TableRow key={item.code_id}>
                          <TableCell className="px-4 align-top text-muted-foreground">
                            {formatDateTime(item.redeemed_at)}
                          </TableCell>
                          <TableCell className="align-top">
                            {item.type_name}
                          </TableCell>
                          <TableCell className="align-top">
                            <div className="flex items-center gap-2">
                              <code className="font-mono text-xs">
                                {item.code}
                              </code>
                              <Button
                                variant="outline"
                                size="xs"
                                onClick={() =>
                                  void copyText(item.code, "兑换码")
                                }
                              >
                                <CopyIcon data-icon="inline-start" />
                                复制
                              </Button>
                            </div>
                          </TableCell>
                          <TableCell className="align-top">
                            <Badge variant="outline">
                              {item.item_count} 份
                            </Badge>
                          </TableCell>
                          <TableCell className="px-4 text-right align-top">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                void openRecordDetail(item.code_id)
                              }
                            >
                              详情
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell
                          className="px-4 text-muted-foreground"
                          colSpan={5}
                        >
                          当前没有匹配的兑换记录。
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>

                <SectionPager
                  page={records?.page || recordFilters.page}
                  pageSize={records?.page_size || 10}
                  total={records?.total || 0}
                  onPageChange={(page) => void loadRecords(undefined, { page })}
                  onPageSizeChange={(pageSize) =>
                    void loadRecords(undefined, { page: 1, pageSize })
                  }
                  onPrev={() =>
                    void loadRecords(undefined, {
                      page: Math.max(1, recordFilters.page - 1),
                    })
                  }
                  onNext={() =>
                    void loadRecords(undefined, {
                      page: recordFilters.page + 1,
                    })
                  }
                />
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      <Dialog open={passwordDialogOpen} onOpenChange={setPasswordDialogOpen}>
        <DialogContent className="max-w-[min(96vw,32rem)] p-0 sm:max-w-[min(96vw,32rem)]">
          <DialogHeader className="border-b border-border/70 px-5 py-4">
            <DialogTitle>修改管理密码</DialogTitle>
            <DialogDescription>统一更新当前后台的管理令牌。</DialogDescription>
          </DialogHeader>
          <form
            className="flex max-h-[min(80svh,28rem)] min-h-0 flex-col"
            onSubmit={handlePasswordUpdate}
          >
            <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-5 py-4">
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="current-admin-token">
                    当前密码
                  </FieldLabel>
                  <FieldContent>
                    <Input
                      id="current-admin-token"
                      type="password"
                      autoComplete="current-password"
                      value={passwordForm.currentToken}
                      onChange={(event) =>
                        setPasswordForm((current) => ({
                          ...current,
                          currentToken: event.target.value,
                        }))
                      }
                    />
                  </FieldContent>
                </Field>
                <Field>
                  <FieldLabel htmlFor="next-admin-token">新密码</FieldLabel>
                  <FieldContent>
                    <Input
                      id="next-admin-token"
                      type="password"
                      autoComplete="new-password"
                      value={passwordForm.newToken}
                      onChange={(event) =>
                        setPasswordForm((current) => ({
                          ...current,
                          newToken: event.target.value,
                        }))
                      }
                    />
                  </FieldContent>
                </Field>
              </FieldGroup>
            </div>
            <DialogFooter className="border-t border-border/70 px-5 py-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => setPasswordDialogOpen(false)}
              >
                取消
              </Button>
              <Button type="submit" disabled={passwordSubmitting}>
                <UserCogIcon data-icon="inline-start" />
                {passwordSubmitting ? "更新中..." : "修改密码"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={recordDetailDialogOpen}
        onOpenChange={(open) => {
          setRecordDetailDialogOpen(open)
          if (!open) {
            setRecordDetail(null)
          }
        }}
      >
        <DialogContent className="max-w-[min(96vw,56rem)] p-0 sm:max-w-[min(96vw,56rem)]">
          <DialogHeader className="border-b border-border/70 px-5 py-4">
            <DialogTitle>兑换记录详情</DialogTitle>
            <DialogDescription>
              {recordDetail
                ? `兑换码 ${recordDetail.code} 共发放 ${recordDetail.item_count} 份`
                : "查看该兑换码对应的邮箱明细"}
            </DialogDescription>
          </DialogHeader>
          <div className="flex max-h-[min(84svh,42rem)] min-h-0 flex-col gap-4 overflow-y-auto px-5 py-4">
            {recordDetailLoading ? (
              <div className="flex flex-col gap-3">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            ) : recordDetail ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{recordDetail.type_name}</Badge>
                    <Badge variant="secondary">
                      {recordDetail.item_count} 份
                    </Badge>
                    <Badge variant="outline">
                      {formatDateTime(recordDetail.redeemed_at)}
                    </Badge>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleDownloadRecordDetail}
                  >
                    <DownloadIcon data-icon="inline-start" />
                    下载 TXT
                  </Button>
                </div>
                {hiddenRecordDetailCount > 0 ? (
                  <Alert>
                    <EyeIcon />
                    <AlertTitle>仅展示前 10 条</AlertTitle>
                    <AlertDescription>
                      当前结果共 {recordDetail.item_count} 条，剩余{" "}
                      {hiddenRecordDetailCount}{" "}
                      条已隐藏，请使用下载按钮查看完整内容。
                    </AlertDescription>
                  </Alert>
                ) : null}
                <div className="flex flex-col gap-3">
                  {visibleRecordDetailItems.map((item, index) => (
                    <Card
                      key={item.id}
                      size="sm"
                      className="border border-border/70 bg-background/70"
                    >
                      <CardHeader className="border-b border-border/70">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline">第 {index + 1} 份</Badge>
                          <Badge variant="secondary">{item.type_name}</Badge>
                        </div>
                      </CardHeader>
                      <CardContent>
                        <pre className="overflow-x-auto bg-muted/60 px-3 py-3 font-mono text-xs leading-6 whitespace-pre-wrap text-foreground">
                          {recordLine(item)}
                        </pre>
                      </CardContent>
                      <DialogFooter className="px-0 pt-3">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            void copyText(
                              recordLine(item),
                              `兑换记录第 ${index + 1} 份内容`
                            )
                          }
                        >
                          <CopyIcon data-icon="inline-start" />
                          复制
                        </Button>
                      </DialogFooter>
                    </Card>
                  ))}
                </div>
              </>
            ) : (
              <div className="text-sm text-muted-foreground">
                未找到兑换记录详情。
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={inventoryImportDialogOpen}
        onOpenChange={setInventoryImportDialogOpen}
      >
        <DialogContent className="max-w-[min(96vw,52rem)] p-0 sm:max-w-[min(96vw,52rem)]">
          <DialogHeader className="border-b border-border/70 px-5 py-4">
            <DialogTitle>导入库存</DialogTitle>
            <DialogDescription>
              每行一条记录，按字段顺序导入；最后一个字段允许包含分隔符内容。
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex max-h-[min(88svh,48rem)] min-h-0 flex-col"
            onSubmit={handleInventoryImport}
          >
            <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-5 py-4">
              <FieldGroup>
                <Field>
                  <FieldLabel>兑换类型</FieldLabel>
                  <FieldContent>
                    <Select
                      value={inventoryImportTypeId || undefined}
                      onValueChange={setInventoryImportTypeId}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="选择兑换类型" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {types.map((type) => (
                            <SelectItem key={type.id} value={String(type.id)}>
                              {type.name}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </FieldContent>
                </Field>
                <Field>
                  <FieldLabel>导入模式</FieldLabel>
                  <FieldContent>
                    <Select
                      value={inventoryImportMode}
                      onValueChange={setInventoryImportMode}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="append">追加并自动去重</SelectItem>
                          <SelectItem value="replace_available">
                            替换当前可用库存
                          </SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </FieldContent>
                </Field>
                <Field>
                  <FieldLabel htmlFor="inventory-import-text">
                    库存文本
                  </FieldLabel>
                  <FieldContent>
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        ref={inventoryImportFileInputRef}
                        type="file"
                        accept=".txt,.csv,text/plain"
                        className="hidden"
                        onChange={(event) => {
                          void handleImportFileSelection(
                            event.currentTarget.files?.[0],
                            setInventoryImportText,
                            "库存导入"
                          )
                          event.currentTarget.value = ""
                        }}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          inventoryImportFileInputRef.current?.click()
                        }
                      >
                        <FileUpIcon data-icon="inline-start" />
                        上传文件
                      </Button>
                    </div>
                    <Textarea
                      id="inventory-import-text"
                      rows={14}
                      value={inventoryImportText}
                      onChange={(event) =>
                        setInventoryImportText(event.target.value)
                      }
                      placeholder="account----password----oauth2id----refreshtoken"
                    />
                    <FieldDescription>
                      支持多行粘贴；以 <code>#</code> 开头的行会被自动忽略。
                    </FieldDescription>
                  </FieldContent>
                </Field>
              </FieldGroup>
            </div>
            <DialogFooter className="border-t border-border/70 px-5 py-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => setInventoryImportDialogOpen(false)}
              >
                取消
              </Button>
              <Button type="submit" disabled={inventorySubmitting}>
                <PackagePlusIcon data-icon="inline-start" />
                {inventorySubmitting ? "导入中..." : "执行导入"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={inventoryBatchEditDialogOpen}
        onOpenChange={setInventoryBatchEditDialogOpen}
      >
        <DialogContent className="max-w-[min(96vw,34rem)] p-0 sm:max-w-[min(96vw,34rem)]">
          <DialogHeader className="border-b border-border/70 px-5 py-4">
            <DialogTitle>批量编辑库存</DialogTitle>
            <DialogDescription>
              当前已选择 {selectedInventoryIds.length}{" "}
              条库存，可同时修改目标类型与可用状态。
            </DialogDescription>
          </DialogHeader>
          <form className="flex flex-col" onSubmit={handleInventoryBatchUpdate}>
            <div className="flex flex-col gap-5 px-5 py-4">
              <FieldGroup>
                <Field>
                  <FieldLabel>目标类型</FieldLabel>
                  <FieldContent>
                    <Select
                      value={inventoryBatchEdit.typeId || "keep"}
                      onValueChange={(value) =>
                        setInventoryBatchEdit((current) => ({
                          ...current,
                          typeId: value === "keep" ? "" : value,
                        }))
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="保持当前类型" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="keep">保持当前类型</SelectItem>
                          {types.map((type) => (
                            <SelectItem key={type.id} value={String(type.id)}>
                              {type.name}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </FieldContent>
                </Field>
                <Field>
                  <FieldLabel>可用状态</FieldLabel>
                  <FieldContent>
                    <Select
                      value={inventoryBatchEdit.status || "keep"}
                      onValueChange={(value) =>
                        setInventoryBatchEdit((current) => ({
                          ...current,
                          status: value === "keep" ? "" : value,
                        }))
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="保持当前状态" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="keep">保持当前状态</SelectItem>
                          <SelectItem value="available">设为可用</SelectItem>
                          <SelectItem value="unavailable">
                            设为不可用
                          </SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <FieldDescription>
                      已兑换库存会被自动跳过，避免影响历史兑换记录。
                    </FieldDescription>
                  </FieldContent>
                </Field>
              </FieldGroup>
            </div>
            <DialogFooter className="border-t border-border/70 px-5 py-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => setInventoryBatchEditDialogOpen(false)}
              >
                取消
              </Button>
              <Button type="submit" disabled={inventoryBatchSubmitting}>
                {inventoryBatchSubmitting ? "保存中..." : "保存批量修改"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={codeBatchEditDialogOpen}
        onOpenChange={setCodeBatchEditDialogOpen}
      >
        <DialogContent className="max-w-[min(96vw,34rem)] p-0 sm:max-w-[min(96vw,34rem)]">
          <DialogHeader className="border-b border-border/70 px-5 py-4">
            <DialogTitle>批量编辑卡密</DialogTitle>
            <DialogDescription>
              当前已选择 {selectedCodeIds.length}{" "}
              个卡密，可同时修改目标类型与可兑数量。
            </DialogDescription>
          </DialogHeader>
          <form className="flex flex-col" onSubmit={handleCodeBatchUpdate}>
            <div className="flex flex-col gap-5 px-5 py-4">
              <FieldGroup>
                <Field>
                  <FieldLabel>目标类型</FieldLabel>
                  <FieldContent>
                    <Select
                      value={codeBatchEdit.typeId || "keep"}
                      onValueChange={(value) =>
                        setCodeBatchEdit((current) => ({
                          ...current,
                          typeId: value === "keep" ? "" : value,
                        }))
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="保持当前类型" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="keep">保持当前类型</SelectItem>
                          {types.map((type) => (
                            <SelectItem key={type.id} value={String(type.id)}>
                              {type.name}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </FieldContent>
                </Field>
                <Field>
                  <FieldLabel htmlFor="code-batch-quantity">
                    可兑数量
                  </FieldLabel>
                  <FieldContent>
                    <Input
                      id="code-batch-quantity"
                      inputMode="numeric"
                      value={codeBatchEdit.quantity}
                      onChange={(event) =>
                        setCodeBatchEdit((current) => ({
                          ...current,
                          quantity: event.target.value,
                        }))
                      }
                      placeholder="留空则保持不变"
                    />
                    <FieldDescription>
                      仅支持未兑换卡密，范围为 1 到 500。
                    </FieldDescription>
                  </FieldContent>
                </Field>
              </FieldGroup>
            </div>
            <DialogFooter className="border-t border-border/70 px-5 py-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => setCodeBatchEditDialogOpen(false)}
              >
                取消
              </Button>
              <Button type="submit" disabled={codeBatchSubmitting}>
                {codeBatchSubmitting ? "保存中..." : "保存批量修改"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={codeGenerateDialogOpen}
        onOpenChange={setCodeGenerateDialogOpen}
      >
        <DialogContent className="max-w-[min(96vw,52rem)] p-0 sm:max-w-[min(96vw,52rem)]">
          <DialogHeader className="border-b border-border/70 px-5 py-4">
            <DialogTitle>生成卡密</DialogTitle>
            <DialogDescription>
              生成后立即入库，可设置兑换数量、备注和过期时间。
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex max-h-[min(88svh,52rem)] min-h-0 flex-col"
            onSubmit={handleCodeGenerate}
          >
            <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-5 py-4">
              <FieldGroup>
                <Field>
                  <FieldLabel>兑换类型</FieldLabel>
                  <FieldContent>
                    <Select
                      value={generateTypeId || undefined}
                      onValueChange={setGenerateTypeId}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="选择兑换类型" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {types.map((type) => (
                            <SelectItem key={type.id} value={String(type.id)}>
                              {type.name}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </FieldContent>
                </Field>
                <div className="grid gap-4 md:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="code-count">数量</FieldLabel>
                    <FieldContent>
                      <Input
                        id="code-count"
                        inputMode="numeric"
                        value={generateCount}
                        onChange={(event) =>
                          setGenerateCount(event.target.value)
                        }
                      />
                    </FieldContent>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="code-quantity">
                      每个卡密兑换数
                    </FieldLabel>
                    <FieldContent>
                      <Input
                        id="code-quantity"
                        inputMode="numeric"
                        value={generateQuantity}
                        onChange={(event) =>
                          setGenerateQuantity(event.target.value)
                        }
                      />
                    </FieldContent>
                  </Field>
                </div>
                <Field>
                  <FieldLabel htmlFor="code-note">批次备注</FieldLabel>
                  <FieldContent>
                    <Input
                      id="code-note"
                      value={generateNote}
                      onChange={(event) => setGenerateNote(event.target.value)}
                      placeholder="例如 4 月活动批次"
                    />
                  </FieldContent>
                </Field>
                <Field>
                  <FieldLabel htmlFor="code-expiry">过期时间</FieldLabel>
                  <FieldContent>
                    <Input
                      id="code-expiry"
                      type="datetime-local"
                      value={toDatetimeLocal(generateExpiresAt)}
                      onChange={(event) =>
                        setGenerateExpiresAt(event.target.value)
                      }
                    />
                    <FieldDescription>
                      留空则表示永久有效，直到被使用或手动禁用。
                    </FieldDescription>
                  </FieldContent>
                </Field>
              </FieldGroup>

              {generatedCodes.length ? (
                <div className="flex flex-col gap-3">
                  <p className="text-xs text-muted-foreground">最新生成结果</p>
                  <Textarea
                    value={generatedCodes.map((item) => item.code).join("\n")}
                    readOnly
                    rows={Math.max(6, Math.min(12, generatedCodes.length + 1))}
                    wrap="off"
                    spellCheck={false}
                    className="min-h-40 resize-y overflow-x-auto font-mono text-xs leading-6"
                  />
                </div>
              ) : null}
            </div>
            <DialogFooter className="border-t border-border/70 px-5 py-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => setCodeGenerateDialogOpen(false)}
              >
                关闭
              </Button>
              <Button type="submit" disabled={codeSubmitting}>
                <KeyRoundIcon data-icon="inline-start" />
                {codeSubmitting ? "生成中..." : "生成兑换码"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={typeDialogOpen} onOpenChange={setTypeDialogOpen}>
        <DialogContent className="max-w-[min(96vw,60rem)] p-0 sm:max-w-[min(96vw,60rem)]">
          <DialogHeader className="border-b border-border/70 px-5 py-4">
            <DialogTitle>
              {editingType ? "编辑兑换类型" : "新增兑换类型"}
            </DialogTitle>
            <DialogDescription>
              定义该类型的字段顺序与导入格式，用户兑换时会按相同结构展示数据。
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex max-h-[min(88svh,54rem)] min-h-0 flex-col overflow-hidden"
            onSubmit={handleTypeSubmit}
          >
            <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-5 py-4">
              <FieldGroup>
                <div className="grid gap-4 lg:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="type-name">类型名称</FieldLabel>
                    <FieldContent>
                      <Input
                        id="type-name"
                        value={typeEditor.name}
                        onChange={(event) =>
                          updateTypeField("name", event.target.value)
                        }
                        placeholder="例如 Outlook OAuth 邮箱"
                      />
                    </FieldContent>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="type-slug">类型标识</FieldLabel>
                    <FieldContent>
                      <Input
                        id="type-slug"
                        value={typeEditor.slug}
                        onChange={(event) =>
                          updateTypeField("slug", event.target.value)
                        }
                        placeholder="例如 outlook-oauth"
                      />
                    </FieldContent>
                  </Field>
                </div>
                <Field>
                  <FieldLabel htmlFor="type-description">类型说明</FieldLabel>
                  <FieldContent>
                    <Textarea
                      id="type-description"
                      rows={3}
                      value={typeEditor.description}
                      onChange={(event) =>
                        updateTypeField("description", event.target.value)
                      }
                      placeholder="说明该类型适合什么场景"
                    />
                  </FieldContent>
                </Field>
                <div className="grid gap-4 lg:grid-cols-2">
                  <Field>
                    <FieldLabel>状态</FieldLabel>
                    <FieldContent>
                      <Select
                        value={typeEditor.is_active ? "active" : "inactive"}
                        onValueChange={(value) =>
                          updateTypeField("is_active", value === "active")
                        }
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectItem value="active">启用</SelectItem>
                            <SelectItem value="inactive">停用</SelectItem>
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </FieldContent>
                  </Field>
                </div>
              </FieldGroup>
              <div className="rounded-none border border-border/70 bg-muted/40 px-3 py-3 text-xs text-muted-foreground">
                当前类型默认按整行数据保存。库存导入时每一行都会作为一条完整数据记录处理。
              </div>
            </div>

            <DialogFooter className="border-t border-border/70 px-5 py-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => setTypeDialogOpen(false)}
              >
                取消
              </Button>
              <Button type="submit" disabled={typeSubmitting}>
                {typeSubmitting
                  ? "保存中..."
                  : editingType
                    ? "保存修改"
                    : "创建类型"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </main>
  )
}
