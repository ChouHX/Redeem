// Package httpapi 是 Go 后端的 HTTP 层。
// 响应包络、状态码、字段名都与 Node 版保持一致，前端不需要改动。
package httpapi

import (
	"encoding/json"
	"net"
	"net/http"
	"strconv"
	"strings"

	"github.com/redeem/backend/internal/config"
	"github.com/redeem/backend/internal/domain"
	"github.com/redeem/backend/internal/store"
)

// API 持有依赖。
type API struct {
	cfg   config.Config
	store *store.Store
	mux   *http.ServeMux
}

// New 构造路由。
func New(cfg config.Config, st *store.Store) *API {
	api := &API{cfg: cfg, store: st, mux: http.NewServeMux()}
	api.routes()
	return api
}

// Handler 返回带中间件的处理器。
func (a *API) Handler() http.Handler {
	return withRecover(withAccessLog(a.mux))
}

type envelope struct {
	Success bool `json:"success"`
	Data    any  `json:"data"`
	Message string `json:"message"`
}

func ok(data any, message string) envelope {
	return envelope{Success: true, Data: data, Message: message}
}

func fail(message string, data any) envelope {
	return envelope{Success: false, Data: data, Message: message}
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	encoder := json.NewEncoder(w)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(payload)
}

func (a *API) ok(w http.ResponseWriter, data any, message string) {
	writeJSON(w, http.StatusOK, ok(data, message))
}

func (a *API) fail(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, fail(message, nil))
}

// failBare 对应 Node 的 `res.status(401).json({ success:false, message })`：
// 认证失败时响应体里没有 data 键，这里保持一致。
func (a *API) failBare(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{"success": false, "message": message})
}

// body 解析 JSON 请求体，解析失败返回空 map（与 express.json 的宽松行为一致）。
func body(request *http.Request) map[string]any {
	if request.Body == nil {
		return map[string]any{}
	}
	var payload map[string]any
	decoder := json.NewDecoder(request.Body)
	decoder.UseNumber()
	if err := decoder.Decode(&payload); err != nil || payload == nil {
		return map[string]any{}
	}
	return payload
}

func str(payload map[string]any, key string) string {
	value, exists := payload[key]
	if !exists || value == nil {
		return ""
	}
	switch typed := value.(type) {
	case string:
		return typed
	case json.Number:
		return typed.String()
	case bool:
		if typed {
			return "true"
		}
		return "false"
	default:
		return ""
	}
}

func intOf(payload map[string]any, key string) int64 {
	raw := strings.TrimSpace(str(payload, key))
	if raw == "" {
		return 0
	}
	parsed, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0
	}
	return parsed
}

func idList(payload map[string]any, key string) []int64 {
	raw, exists := payload[key]
	if !exists {
		return nil
	}
	items, isList := raw.([]any)
	if !isList {
		return nil
	}
	seen := map[int64]struct{}{}
	ids := make([]int64, 0, len(items))
	for _, item := range items {
		var value int64
		switch typed := item.(type) {
		case json.Number:
			parsed, err := typed.Int64()
			if err != nil {
				continue
			}
			value = parsed
		case string:
			parsed, err := strconv.ParseInt(strings.TrimSpace(typed), 10, 64)
			if err != nil {
				continue
			}
			value = parsed
		case float64:
			value = int64(typed)
		default:
			continue
		}
		if value < 1 {
			continue
		}
		if _, dup := seen[value]; dup {
			continue
		}
		seen[value] = struct{}{}
		ids = append(ids, value)
	}
	return ids
}

func boundedInt(value string, fallback, min, max int) int {
	parsed, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || parsed < min {
		return fallback
	}
	if parsed > max {
		return max
	}
	return parsed
}

// requireAdmin 校验 Bearer 令牌；令牌来源是 system_config.admin_token，回落到环境变量。
func (a *API) requireAdmin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		header := strings.TrimSpace(request.Header.Get("Authorization"))
		if !strings.HasPrefix(header, "Bearer ") {
			a.failBare(w, http.StatusUnauthorized, "未提供认证令牌")
			return
		}
		token := strings.TrimSpace(strings.TrimPrefix(header, "Bearer "))
		if token == "" {
			a.failBare(w, http.StatusUnauthorized, "未提供认证令牌")
			return
		}
		if !a.verifyAdminToken(token) {
			a.failBare(w, http.StatusUnauthorized, "无效的管理令牌")
			return
		}
		next(w, request)
	}
}

func (a *API) verifyAdminToken(token string) bool {
	stored, exists, err := a.store.GetSystemConfigValue("admin_token")
	if err == nil && exists && stored != "" {
		return token == stored
	}
	return token == a.cfg.AdminToken
}

// requesterIP 与 Node 的 getRequesterIp 同序：优先 X-Forwarded-For 第一段。
func requesterIP(request *http.Request) string {
	if forwarded := request.Header.Get("X-Forwarded-For"); forwarded != "" {
		first := strings.TrimSpace(strings.Split(forwarded, ",")[0])
		if first != "" {
			return first
		}
	}
	if realIP := strings.TrimSpace(request.Header.Get("X-Real-IP")); realIP != "" {
		return realIP
	}
	host, _, err := net.SplitHostPort(request.RemoteAddr)
	if err != nil {
		return strings.TrimPrefix(request.RemoteAddr, "::ffff:")
	}
	return strings.TrimPrefix(host, "::ffff:")
}

// resultEntry 是兑换结果条目的公共视图。
// 兑换返回的是库存行，查询返回的是记录行，两者字段同名但类型不同，
// 这里抽一层，避免把 buildRedeemResultPayload 写两遍。
type resultEntry struct {
	TypeID            int64
	TypeSlug          string
	TypeName          string
	TypeDescription   string
	FieldSchema       []domain.Field
	MailProtocol      string
	TypeMailProtocols []string
	ImportDelimiter   string
	Payload           domain.Payload
	MailProtocols     []string
}

func entryFromRecord(record store.Record) resultEntry {
	return resultEntry{
		TypeID:            record.TypeID,
		TypeSlug:          record.TypeSlug,
		TypeName:          record.TypeName,
		TypeDescription:   record.TypeDescription,
		FieldSchema:       record.FieldSchema,
		MailProtocol:      record.MailProtocol,
		TypeMailProtocols: record.TypeMailProtocols,
		ImportDelimiter:   record.ImportDelimiter,
		Payload:           record.Payload,
		MailProtocols:     record.MailProtocols,
	}
}

func entryFromInventory(item store.Inventory) resultEntry {
	return resultEntry{
		TypeID:            item.TypeID,
		TypeSlug:          item.TypeSlug,
		TypeName:          item.TypeName,
		FieldSchema:       item.FieldSchema,
		MailProtocol:      item.MailProtocol,
		TypeMailProtocols: item.TypeMailProtocols,
		ImportDelimiter:   item.ImportDelimiter,
		Payload:           item.Payload,
		MailProtocols:     item.MailProtocols,
	}
}

func entriesFromRecords(records []store.Record) []resultEntry {
	entries := make([]resultEntry, 0, len(records))
	for _, record := range records {
		entries = append(entries, entryFromRecord(record))
	}
	return entries
}

func entriesFromInventories(items []store.Inventory) []resultEntry {
	entries := make([]resultEntry, 0, len(items))
	for _, item := range items {
		entries = append(entries, entryFromInventory(item))
	}
	return entries
}

// redeemResultPayload 复现 buildRedeemResultPayload 的结构。
// meta 里的键先铺开，再用 mail_protocols / type / items 覆盖，
// 顺序与 Node 一致；fallback 只在分页越界拿不到条目时兜底。
func redeemResultPayload(entries []resultEntry, meta map[string]any, fallback domain.RedeemEmailType) (map[string]any, error) {
	items := make([]domain.RedeemResultItem, 0, len(entries))
	for _, entry := range entries {
		emailType := domain.RedeemEmailType{
			ID:              entry.TypeID,
			Slug:            entry.TypeSlug,
			Name:            entry.TypeName,
			Description:     entry.TypeDescription,
			FieldSchema:     entry.FieldSchema,
			MailProtocol:    entry.MailProtocol,
			MailProtocols:   entry.TypeMailProtocols,
			ImportDelimiter: entry.ImportDelimiter,
		}
		item, err := domain.FormatRedeemResultItem(emailType, entry.Payload, entry.MailProtocols)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}

	var typeView domain.RedeemResultType
	if len(entries) > 0 {
		first := entries[0]
		typeView = domain.FormatRedeemResultType(domain.RedeemEmailType{
			ID:              first.TypeID,
			Slug:            first.TypeSlug,
			Name:            first.TypeName,
			Description:     first.TypeDescription,
			MailProtocol:    first.MailProtocol,
			MailProtocols:   first.TypeMailProtocols,
			ImportDelimiter: first.ImportDelimiter,
		})
	} else {
		typeView = domain.FormatRedeemResultType(fallback)
	}

	payload := map[string]any{}
	for key, value := range meta {
		if key == "type" {
			continue
		}
		payload[key] = value
	}
	payload["mail_protocols"] = domain.CollectResultMailProtocols(items, domain.RedeemEmailType{
		MailProtocol:  typeView.MailProtocol,
		MailProtocols: typeView.MailProtocols,
	})
	payload["type"] = typeView
	payload["items"] = items
	return payload, nil
}

// ensureRedeemDataAvailable 对应 ensureRedeemDataAvailable：超窗口直接 410 拦截。
func (a *API) ensureRedeemDataAvailable(w http.ResponseWriter, code *store.Code) bool {
	if code == nil || code.Status != "redeemed" {
		return true
	}
	if code.DataDeletedAt != nil && *code.DataDeletedAt != "" {
		a.fail(w, http.StatusGone, "该卡密对应的账号信息已删除；取件请手动导入账号数据")
		return false
	}
	if code.RedeemedAt != nil && a.store.AccessExpired(*code.RedeemedAt) {
		a.fail(w, http.StatusGone, "兑换已超过24小时，在线访问已关闭；取件请手动导入账号数据")
		return false
	}
	return true
}

