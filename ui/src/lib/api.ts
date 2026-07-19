export type ApiEnvelope<T> = {
  success: boolean
  data: T
  message: string
}

export type FieldSchema = {
  key: string
  label: string
  required: boolean
  sensitive: boolean
  placeholder?: string
}

export type MailAddress = {
  name?: string
  address?: string
}

export type MailRecipient = {
  emailAddress?: MailAddress
}

export type AdSlotAction = {
  label: string
  href: string
}

export type AdSlotConfig = {
  enabled: boolean
  title: string
  description: string
  image_url: string
  primary_action: AdSlotAction
}

export type FaqConfig = {
  html: string
}

export type MailProtocol = "imap" | "graph"
export type MailFolder = "inbox" | "spam"

export type MailMessageSummary = {
  id?: string
  folder?: MailFolder
  subject?: string
  sender?: {
    emailAddress?: MailAddress
  }
  from?: {
    emailAddress?: MailAddress
  }
  toRecipients?: MailRecipient[]
  receivedDateTime?: string
  bodyPreview?: string
  contentType?: string
}

export type MailMessage = MailMessageSummary & {
  body?: {
    content?: string
    contentType?: string
  }
}

export type MailListResult = {
  email: string
  folder: MailFolder
  total: number
  page: number
  page_size: number
  items: MailMessage[]
}

export type MailDetailResult = {
  email: string
  folder: MailFolder
  item: MailMessage
}

export type TempMailAccount = {
  email: string
  password: string
  client_id: string
  refresh_token: string
  mail_protocol?: MailProtocol
}

export type RedeemAccessResult = {
  source: "newly_redeemed" | "existing"
  code: string
  redeemed_at: string | null
  total: number
  page: number
  page_size: number
  items: RedeemedItem[]
}

export type RedeemType = {
  id: number
  slug: string
  name: string
  description: string
  mail_protocol?: MailProtocol
  mail_protocols: MailProtocol[]
  import_delimiter: string
  is_active: boolean
  available_inventory_count: number
  available_inventory_by_protocol?: Partial<Record<MailProtocol, number>>
  available_code_count: number
  redeemed_count: number
  field_schema: FieldSchema[]
}

export type RedeemCatalog = {
  types: RedeemType[]
}

export type RedeemFieldValue = FieldSchema & {
  value: string
}

export type RedeemedItem = {
  mail_protocols?: MailProtocol[]
  type: {
    id: number | null
    slug: string
    name: string
    description: string
    mail_protocol?: MailProtocol
    mail_protocols?: MailProtocol[]
    import_delimiter: string
  }
  fields: RedeemFieldValue[]
  payload: Record<string, string>
  formatted_line: string
}

export type RedeemExchangeResult = {
  record_id: number | null
  record_ids: number[]
  quantity: number
  redeemed_count: number
  redeemed_at: string
  code: string
  type: {
    id: number | null
    slug: string
    name: string
    description: string
    mail_protocol?: MailProtocol
    mail_protocols?: MailProtocol[]
    import_delimiter: string
  }
  items: RedeemedItem[]
  fields: RedeemFieldValue[]
  payload: Record<string, string>
  formatted_line: string
}

export type RedeemOrderQueryResult = {
  code: string
  item_count: number
  redeemed_at: string
  type: {
    id: number | null
    slug: string
    name: string
    description: string
    mail_protocol?: MailProtocol
    mail_protocols?: MailProtocol[]
    import_delimiter: string
  }
  items: RedeemedItem[]
}

export type GeminiProTaskStatus = 1 | 2 | 3 | 4 | 5

export type GeminiProTaskItem = {
  id: number
  card_code: string
  account_info: string
  status: GeminiProTaskStatus
  result: string
  submitted_at: string | null
  completed_at: string | null
  you_hui_url: string
  type: number
  is_you_hui_url: number
  status_desc: string
}

export type GeminiProCardCodeObj = {
  total_quota: number
  used_quota: number
  type: number
}

export type GeminiProTasksResult = {
  items: GeminiProTaskItem[]
  card_code_obj: GeminiProCardCodeObj
  total: number
  page: number
  page_size: number
}

export type GeminiProSubmitPayload = {
  card: string
  accounts: string[]
}

export type AdminOverview = {
  type_count: number
  total_inventory_count: number
  available_inventory_count: number
  unavailable_inventory_count: number
  redeemed_inventory_count: number
  total_code_count: number
  unused_code_count: number
  redeemed_code_count: number
  disabled_code_count: number
  record_count: number
}

export type PagedResult<T> = {
  items: T[]
  total: number
  page: number
  page_size: number
}

export type RedeemInventoryItem = {
  id: number
  type_id: number
  type_name: string
  type_slug: string
  field_schema?: FieldSchema[]
  mail_protocol?: MailProtocol
  mail_protocols?: MailProtocol[]
  import_delimiter: string
  payload: Record<string, string>
  serialized_value: string
  status: "available" | "unavailable" | "redeemed"
  redeemed_code_id: number | null
  redeemed_at: string | null
  created_at: string
  updated_at: string
}

export type RedeemCodeItem = {
  id: number
  code: string
  normalized_code: string
  type_id: number
  type_name: string
  type_slug: string
  quantity: number
  redeemed_quantity: number
  remaining_quantity: number
  note: string
  status: "unused" | "redeemed" | "disabled"
  derived_status: "unused" | "redeemed" | "disabled" | "expired"
  expires_at: string | null
  redeemed_inventory_id: number | null
  redeemed_at: string | null
  data_deleted_at: string | null
  data_deleted_reason: string
  created_at: string
  updated_at: string
}

export type CodeBatchStatusResult = {
  updated_count: number
  skipped_count: number
  total_count: number
  status: "unused" | "disabled"
}

export type InventoryBatchUpdateResult = {
  updated_count: number
  skipped_count: number
  total_count: number
  status: "available" | "unavailable" | null
  type_id: number | null
}

export type CodeBatchUpdateResult = {
  updated_count: number
  skipped_count: number
  total_count: number
  type_id: number | null
  quantity: number | null
}

export type CodeBatchDeleteResult = {
  deleted_count: number
  skipped_count: number
  total_count: number
}

export type RedeemTypeDeleteResult = {
  type: RedeemType
  deleted_type_count: number
  deleted_inventory_count: number
  deleted_code_count: number
  deleted_record_count: number
}

export type RedeemRollbackResult = {
  code_id: number
  code: string
  restored_inventory_count: number
  deleted_record_count: number
}

export type TokenCheckJobStatus = "running" | "completed" | "failed"

export type TokenCheckJob = {
  id: string
  type_id: number
  type_name: string
  inventory_status: "available" | "unavailable" | "redeemed"
  status: TokenCheckJobStatus
  delete_abnormal: boolean
  total_count: number
  processed_count: number
  live_count: number
  expired_count: number
  error_count: number
  deleted_count: number
  started_at: string
  finished_at: string | null
  error_message: string
  error_codes: Record<string, number>
}

export type RedeemRecordItem = {
  id: number
  code_id: number
  inventory_id: number
  type_id: number
  code: string
  normalized_code: string
  type_name: string
  type_slug: string
  field_schema?: FieldSchema[]
  mail_protocol?: MailProtocol
  mail_protocols?: MailProtocol[]
  import_delimiter: string
  payload: Record<string, string>
  requester_ip: string
  requester_user_agent: string
  redeemed_at: string
}

export type RedeemRecordGroup = {
  code_id: number
  type_id: number
  code: string
  normalized_code: string
  type_name: string
  type_slug: string
  mail_protocol?: MailProtocol
  mail_protocols?: MailProtocol[]
  item_count: number
  redeemed_at: string
  requester_ip: string
  requester_user_agent: string
}

export type RedeemRecordDetail = {
  code_id: number
  code: string
  type_id: number
  type_name: string
  type_slug: string
  redeemed_at: string
  item_count: number
  items: RedeemRecordItem[]
}

export type InventoryImportResult = {
  type: RedeemType
  parse: {
    parsed_count: number
    error_count: number
    errors: string[]
  }
  import: {
    mode: string
    cleared_count: number
    added_count: number
    skipped_count: number
    total_count: number
  }
}

export type TypeFormPayload = {
  name: string
  slug: string
  description: string
  mail_protocols: MailProtocol[]
  import_delimiter: string
  is_active: boolean
  field_schema: FieldSchema[]
}

export class ApiError extends Error {
  status: number
  payload: unknown

  constructor(message: string, status: number, payload: unknown) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.payload = payload
  }
}

type RequestOptions = Omit<RequestInit, "body"> & {
  token?: string
  body?: BodyInit | Record<string, unknown> | null
}

const API_BASE_URL = String(import.meta.env.VITE_API_BASE_URL || "").replace(
  /\/+$/,
  ""
)

function resolveApiUrl(url: string) {
  if (!API_BASE_URL || /^https?:\/\//i.test(url)) {
    return url
  }

  return `${API_BASE_URL}${url.startsWith("/") ? url : `/${url}`}`
}

function createHeaders(
  token?: string,
  init?: HeadersInit,
  body?: RequestOptions["body"]
) {
  const headers = new Headers(init)
  if (!(body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json")
  }

  if (token) {
    headers.set("Authorization", `Bearer ${token}`)
  }

  return headers
}

function createQuery(params: Record<string, string | number | undefined>) {
  const searchParams = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") {
      continue
    }
    searchParams.set(key, String(value))
  }
  const query = searchParams.toString()
  return query ? `?${query}` : ""
}

export async function apiRequest<T>(
  url: string,
  { token, headers, body, ...init }: RequestOptions = {}
) {
  const response = await fetch(resolveApiUrl(url), {
    ...init,
    headers: createHeaders(token, headers, body),
    body:
      typeof body === "string" || body instanceof FormData || body == null
        ? body
        : JSON.stringify(body),
  })

  const payload = (await response
    .json()
    .catch(() => null)) as ApiEnvelope<T> | null
  if (!response.ok || !payload?.success) {
    throw new ApiError(
      payload?.message || `请求失败 (${response.status})`,
      response.status,
      payload
    )
  }

  return payload
}

export async function textRequest(
  url: string,
  { token, headers, body, ...init }: RequestOptions = {}
) {
  const response = await fetch(resolveApiUrl(url), {
    ...init,
    headers: createHeaders(token, headers, body),
    body:
      typeof body === "string" || body instanceof FormData || body == null
        ? body
        : JSON.stringify(body),
  })

  if (!response.ok) {
    const maybeJson = (await response
      .json()
      .catch(() => null)) as ApiEnvelope<unknown> | null
    throw new ApiError(
      maybeJson?.message || `请求失败 (${response.status})`,
      response.status,
      maybeJson
    )
  }

  return response
}

export async function verifyAdminToken(token: string) {
  const payload = await apiRequest<null>("/api/admin/verify", {
    method: "POST",
    body: { token },
  })
  return payload.success
}

export async function fetchRedeemCatalog() {
  const payload = await apiRequest<RedeemCatalog>("/api/redeem/catalog", {
    method: "GET",
  })
  return payload.data
}

export async function fetchPublicAds() {
  const payload = await apiRequest<AdSlotConfig>("/api/ui/ads", {
    method: "GET",
  })
  return payload.data
}

export async function fetchPublicFaq() {
  const payload = await apiRequest<FaqConfig>("/api/ui/faq", {
    method: "GET",
  })
  return payload.data
}

export async function exchangeRedeemCode(code: string) {
  const payload = await apiRequest<RedeemExchangeResult>(
    "/api/redeem/exchange",
    {
      method: "POST",
      body: { code },
    }
  )
  return payload
}

export async function queryRedeemOrder(code: string) {
  const payload = await apiRequest<RedeemOrderQueryResult>(
    "/api/redeem/query",
    {
      method: "POST",
      body: { code },
    }
  )
  return payload.data
}

export async function accessMailboxByCode(
  code: string,
  params: {
    page?: number
    page_size?: number
  } = {}
) {
  const payload = await apiRequest<RedeemAccessResult>("/api/redeem/access", {
    method: "POST",
    body: {
      code,
      page: params.page,
      page_size: params.page_size,
    },
  })
  return payload
}

export async function fetchGeminiProTasks(
  cardCode: string,
  params: {
    page?: number
    page_size?: number
  } = {}
) {
  const payload = await apiRequest<GeminiProTasksResult>(
    `/api/geminipro/tasks/${encodeURIComponent(cardCode)}${createQuery({
      page: params.page,
      page_size: params.page_size,
    })}`,
    {
      method: "GET",
    }
  )
  return payload.data
}

export async function submitGeminiProTasks(body: GeminiProSubmitPayload) {
  const payload = await apiRequest<unknown>("/api/geminipro/submit", {
    method: "POST",
    body,
  })
  return payload
}

export async function fetchTempMailboxMessages(
  account: TempMailAccount,
  params: {
    folder?: MailFolder
    page?: number
    page_size?: number
    include_bodies?: boolean
  } = {}
) {
  const payload = await apiRequest<MailListResult>(
    "/api/mailboxes/temp/messages",
    {
      method: "POST",
      body: {
        ...account,
        folder: params.folder,
        page: params.page,
        page_size: params.page_size,
        include_bodies: params.include_bodies,
      },
    }
  )
  return payload.data
}

export async function fetchTempMailboxMessageDetail(
  account: TempMailAccount,
  messageId: string,
  folder: MailFolder = "inbox"
) {
  const payload = await apiRequest<MailDetailResult>(
    `/api/mailboxes/temp/messages/${encodeURIComponent(messageId)}`,
    {
      method: "POST",
      body: {
        ...account,
        folder,
      },
    }
  )
  return payload.data
}

export async function fetchAdminOverview(token: string) {
  const payload = await apiRequest<AdminOverview>(
    "/api/redeem/admin/overview",
    {
      method: "GET",
      token,
    }
  )
  return payload.data
}

export async function fetchAdminAds(token: string) {
  const payload = await apiRequest<AdSlotConfig>("/api/system/ads", {
    method: "GET",
    token,
  })
  return payload.data
}

export async function updateAdminAds(token: string, body: AdSlotConfig) {
  const payload = await apiRequest<AdSlotConfig>("/api/system/ads", {
    method: "POST",
    token,
    body,
  })
  return payload
}

export async function fetchAdminFaq(token: string) {
  const payload = await apiRequest<FaqConfig>("/api/system/faq", {
    method: "GET",
    token,
  })
  return payload.data
}

export async function updateAdminFaq(token: string, markdown: string) {
  const payload = await apiRequest<FaqConfig>("/api/system/faq", {
    method: "POST",
    token,
    body: { html: markdown },
  })
  return payload
}

export async function fetchAdminTypes(token: string, includeInactive = true) {
  const payload = await apiRequest<{ items: RedeemType[] }>(
    `/api/redeem/admin/types${createQuery({
      include_inactive: includeInactive ? "true" : "false",
    })}`,
    {
      method: "GET",
      token,
    }
  )
  return payload.data.items
}

export async function createAdminType(token: string, body: TypeFormPayload) {
  const payload = await apiRequest<RedeemType>("/api/redeem/admin/types", {
    method: "POST",
    token,
    body,
  })
  return payload
}

export async function updateAdminType(
  token: string,
  typeId: number,
  body: TypeFormPayload
) {
  const payload = await apiRequest<RedeemType>(
    `/api/redeem/admin/types/${typeId}`,
    {
      method: "PUT",
      token,
      body,
    }
  )
  return payload
}

export async function deleteAdminType(token: string, typeId: number) {
  return apiRequest<RedeemTypeDeleteResult>(
    `/api/redeem/admin/types/${typeId}`,
    {
      method: "DELETE",
      token,
    }
  )
}

export async function fetchAdminInventory(
  token: string,
  params: {
    type_id?: string
    status?: string
    q?: string
    page?: number
    page_size?: number
  }
) {
  const payload = await apiRequest<PagedResult<RedeemInventoryItem>>(
    `/api/redeem/admin/inventory${createQuery(params)}`,
    {
      method: "GET",
      token,
    }
  )
  return payload.data
}

export async function importAdminInventory(
  token: string,
  body: {
    type_id: number
    mode: string
    text: string
    mail_protocols: MailProtocol[]
  }
) {
  const payload = await apiRequest<InventoryImportResult>(
    "/api/redeem/admin/inventory/import",
    {
      method: "POST",
      token,
      body,
    }
  )
  return payload
}

export async function importAdminInventoryFile(
  token: string,
  body: {
    type_id: number
    mode: string
    file: File
    mail_protocols: MailProtocol[]
  },
  options: {
    onUploadProgress?: (progress: number) => void
    onPhaseChange?: (phase: "uploading" | "processing") => void
  } = {}
) {
  const formData = new FormData()
  formData.set("type_id", String(body.type_id))
  formData.set("mode", body.mode)
  formData.set("mail_protocols", JSON.stringify(body.mail_protocols))
  formData.set("file", body.file)

  return await new Promise<ApiEnvelope<InventoryImportResult>>(
    (resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open(
        "POST",
        resolveApiUrl("/api/redeem/admin/inventory/import"),
        true
      )

      if (token) {
        xhr.setRequestHeader("Authorization", `Bearer ${token}`)
      }

      xhr.upload.onprogress = (event) => {
        options.onPhaseChange?.("uploading")
        if (event.lengthComputable) {
          options.onUploadProgress?.(
            Math.max(
              1,
              Math.min(95, Math.round((event.loaded / event.total) * 90))
            )
          )
        }
      }

      xhr.upload.onload = () => {
        options.onPhaseChange?.("processing")
        options.onUploadProgress?.(95)
      }

      xhr.onerror = () => {
        reject(new ApiError("上传失败，请稍后重试", 0, null))
      }

      xhr.onload = () => {
        const payload = JSON.parse(
          xhr.responseText || "null"
        ) as ApiEnvelope<InventoryImportResult> | null
        if (xhr.status >= 200 && xhr.status < 300 && payload?.success) {
          options.onUploadProgress?.(100)
          resolve(payload)
          return
        }

        reject(
          new ApiError(
            payload?.message || `请求失败 (${xhr.status})`,
            xhr.status,
            payload
          )
        )
      }

      xhr.send(formData)
    }
  )
}

export async function deleteAdminInventory(token: string, inventoryId: number) {
  const payload = await apiRequest<{ inventory_id: number }>(
    `/api/redeem/admin/inventory/${inventoryId}`,
    {
      method: "DELETE",
      token,
    }
  )
  return payload
}

export async function updateAdminInventoryStatus(
  token: string,
  inventoryId: number,
  status: "available" | "unavailable"
) {
  const payload = await apiRequest<RedeemInventoryItem>(
    `/api/redeem/admin/inventory/${inventoryId}/status`,
    {
      method: "POST",
      token,
      body: { status },
    }
  )
  return payload
}

export async function batchDeleteAdminInventory(
  token: string,
  inventoryIds: number[]
) {
  const payload = await apiRequest<{ deleted_count: number }>(
    "/api/redeem/admin/inventory/batch-delete",
    {
      method: "POST",
      token,
      body: { inventory_ids: inventoryIds },
    }
  )
  return payload
}

export async function batchUpdateAdminInventory(
  token: string,
  body: {
    inventory_ids: number[]
    type_id?: number
    status?: "available" | "unavailable"
  }
) {
  const payload = await apiRequest<InventoryBatchUpdateResult>(
    "/api/redeem/admin/inventory/batch-update",
    {
      method: "POST",
      token,
      body,
    }
  )
  return payload
}

export async function exportAdminInventoryText(
  token: string,
  inventoryIds: number[]
) {
  const response = await textRequest("/api/redeem/admin/inventory/export", {
    method: "POST",
    token,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ inventory_ids: inventoryIds }),
  })
  const text = await response.text()
  const disposition = response.headers.get("content-disposition") || ""
  const match = disposition.match(/filename=([^;]+)/i)
  return {
    text,
    filename: match?.[1] || "redeem_inventory.txt",
  }
}

export async function fetchAdminCodes(
  token: string,
  params: {
    type_id?: string
    status?: string
    q?: string
    min_quantity?: string
    max_quantity?: string
    page?: number
    page_size?: number
  }
) {
  const payload = await apiRequest<PagedResult<RedeemCodeItem>>(
    `/api/redeem/admin/codes${createQuery(params)}`,
    {
      method: "GET",
      token,
    }
  )
  return payload.data
}

export async function generateAdminCodes(
  token: string,
  body: {
    type_id: number
    count: number
    quantity: number
    note: string
    expires_at?: string
  }
) {
  const payload = await apiRequest<{ items: RedeemCodeItem[] }>(
    "/api/redeem/admin/codes/generate",
    {
      method: "POST",
      token,
      body,
    }
  )
  return payload
}

export async function updateAdminCodeStatus(
  token: string,
  codeId: number,
  status: "unused" | "disabled"
) {
  const payload = await apiRequest<RedeemCodeItem>(
    `/api/redeem/admin/codes/${codeId}/status`,
    {
      method: "POST",
      token,
      body: { status },
    }
  )
  return payload
}

export async function rollbackAdminCode(token: string, codeId: number) {
  const payload = await apiRequest<RedeemRollbackResult>(
    `/api/redeem/admin/codes/${codeId}/rollback`,
    {
      method: "POST",
      token,
    }
  )
  return payload
}

export async function deleteAdminCode(token: string, codeId: number) {
  const payload = await apiRequest<{ code_id: number }>(
    `/api/redeem/admin/codes/${codeId}`,
    {
      method: "DELETE",
      token,
    }
  )
  return payload
}

export async function batchUpdateAdminCodeStatus(
  token: string,
  codeIds: number[],
  status: "unused" | "disabled"
) {
  const payload = await apiRequest<CodeBatchStatusResult>(
    "/api/redeem/admin/codes/batch-status",
    {
      method: "POST",
      token,
      body: { code_ids: codeIds, status },
    }
  )
  return payload
}

export async function batchDeleteAdminCodes(token: string, codeIds: number[]) {
  const payload = await apiRequest<CodeBatchDeleteResult>(
    "/api/redeem/admin/codes/batch-delete",
    {
      method: "POST",
      token,
      body: { code_ids: codeIds },
    }
  )
  return payload
}

export async function batchUpdateAdminCodes(
  token: string,
  body: {
    code_ids: number[]
    type_id?: number
    quantity?: number
  }
) {
  const payload = await apiRequest<CodeBatchUpdateResult>(
    "/api/redeem/admin/codes/batch-update",
    {
      method: "POST",
      token,
      body,
    }
  )
  return payload
}

export async function exportAdminCodesText(
  token: string,
  body:
    | {
        code_ids: number[]
      }
    | {
        type_id?: string
        status?: string
        q?: string
        min_quantity?: string
        max_quantity?: string
      }
) {
  const response = await textRequest("/api/redeem/admin/codes/export", {
    method: "POST",
    token,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  const disposition = response.headers.get("content-disposition") || ""
  const match = disposition.match(/filename=([^;]+)/i)
  return {
    text,
    filename: match?.[1] || "redeem_codes.txt",
  }
}

export async function fetchAdminRecords(
  token: string,
  params: {
    type_id?: string
    q?: string
    page?: number
    page_size?: number
  }
) {
  const payload = await apiRequest<PagedResult<RedeemRecordGroup>>(
    `/api/redeem/admin/records${createQuery(params)}`,
    {
      method: "GET",
      token,
    }
  )
  return payload.data
}

export async function startAdminTokenCheck(
  token: string,
  body: {
    type_id: number
    inventory_status: "available" | "unavailable" | "redeemed"
    delete_abnormal: boolean
  }
) {
  const payload = await apiRequest<TokenCheckJob>(
    "/api/redeem/admin/token-checks",
    {
      method: "POST",
      token,
      body,
    }
  )
  return payload
}

export async function fetchAdminTokenChecks(token: string, limit = 20) {
  const payload = await apiRequest<{ items: TokenCheckJob[] }>(
    `/api/redeem/admin/token-checks${createQuery({ limit })}`,
    {
      method: "GET",
      token,
    }
  )
  return payload.data.items
}

export async function fetchAdminTokenCheck(token: string, jobId: string) {
  const payload = await apiRequest<TokenCheckJob>(
    `/api/redeem/admin/token-checks/${encodeURIComponent(jobId)}`,
    {
      method: "GET",
      token,
    }
  )
  return payload.data
}

export async function downloadAdminTokenCheck(
  token: string,
  jobId: string,
  outcome: "live" | "expired" | "error"
) {
  const response = await textRequest(
    `/api/redeem/admin/token-checks/${encodeURIComponent(jobId)}/download/${outcome}`,
    {
      method: "GET",
      token,
    }
  )
  const text = await response.text()
  const disposition = response.headers.get("content-disposition") || ""
  const match = disposition.match(/filename=([^;]+)/i)
  return {
    text,
    filename: match?.[1] || `token_check_${outcome}.txt`,
  }
}

export async function deleteAdminTokenCheckAbnormal(
  token: string,
  jobId: string
) {
  const payload = await apiRequest<TokenCheckJob>(
    `/api/redeem/admin/token-checks/${encodeURIComponent(jobId)}/delete-abnormal`,
    {
      method: "POST",
      token,
    }
  )
  return payload
}

export async function fetchAdminRecordDetail(token: string, codeId: number) {
  const payload = await apiRequest<RedeemRecordDetail>(
    `/api/redeem/admin/records/${codeId}`,
    {
      method: "GET",
      token,
    }
  )
  return payload.data
}

export async function updateAdminPassword(
  token: string,
  body: {
    current_token: string
    new_token: string
  }
) {
  const payload = await apiRequest<{ token: string }>("/api/admin/password", {
    method: "POST",
    token,
    body,
  })
  return payload
}
