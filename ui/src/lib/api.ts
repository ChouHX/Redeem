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
  items: MailMessageSummary[]
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
}

export type RedeemAccessResult = {
  source: "newly_redeemed" | "existing"
  code: string
  redeemed_at: string | null
  items: RedeemedItem[]
}

export type RedeemType = {
  id: number
  slug: string
  name: string
  description: string
  import_delimiter: string
  is_active: boolean
  available_inventory_count: number
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
  type: {
    id: number | null
    slug: string
    name: string
    description: string
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
    import_delimiter: string
  }
  items: RedeemedItem[]
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
  const response = await fetch(url, {
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
  const response = await fetch(url, {
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

export async function accessMailboxByCode(code: string) {
  const payload = await apiRequest<RedeemAccessResult>("/api/redeem/access", {
    method: "POST",
    body: { code },
  })
  return payload
}

export async function fetchLatestMail(email: string, top = 1) {
  const payload = await apiRequest<MailMessage[]>(
    `/api/messages${createQuery({ email, top })}`,
    {
      method: "GET",
    }
  )
  return payload
}

export async function fetchLatestMailWithTempAccount(
  account: TempMailAccount,
  top = 1
) {
  const payload = await apiRequest<MailMessage[]>("/api/temp-messages", {
    method: "POST",
    body: {
      ...account,
      top,
    },
  })
  return payload
}

export async function fetchMailboxMessages(
  email: string,
  params: {
    folder?: MailFolder
    page?: number
    page_size?: number
  } = {}
) {
  const payload = await apiRequest<MailListResult>(
    `/api/mailboxes/messages${createQuery({
      email,
      folder: params.folder,
      page: params.page,
      page_size: params.page_size,
    })}`,
    {
      method: "GET",
    }
  )
  return payload.data
}

export async function fetchMailboxMessageDetail(
  email: string,
  messageId: string,
  folder: MailFolder = "inbox"
) {
  const payload = await apiRequest<MailDetailResult>(
    `/api/mailboxes/messages/${encodeURIComponent(messageId)}${createQuery({
      email,
      folder,
    })}`,
    {
      method: "GET",
    }
  )
  return payload.data
}

export async function fetchTempMailboxMessages(
  account: TempMailAccount,
  params: {
    folder?: MailFolder
    page?: number
    page_size?: number
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
