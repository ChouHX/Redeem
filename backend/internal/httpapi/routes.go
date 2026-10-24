package httpapi

import (
	"net/http"
	"os"
	"strconv"
	"path/filepath"
	"strings"

	"github.com/redeem/backend/internal/domain"
	"github.com/redeem/backend/internal/store"
)

func (a *API) routes() {
	// 公开接口
	a.mux.HandleFunc("GET /api/redeem/catalog", a.handleCatalog)
	a.mux.HandleFunc("POST /api/redeem/query", a.handleQuery)
	a.mux.HandleFunc("POST /api/redeem/exchange", a.handleExchange)
	a.mux.HandleFunc("POST /api/redeem/access", a.handleAccess)
	a.mux.HandleFunc("POST /api/temp-messages", a.handleTempMessages)
	a.mux.HandleFunc("POST /api/mailboxes/temp/messages", a.handleMailboxList)
	a.mux.HandleFunc("POST /api/mailboxes/temp/messages/{messageId}", a.handleMailboxDetail)
	a.mux.HandleFunc("GET /api/geminipro/tasks/{cardCode}", a.handleGeminiTasks)
	a.mux.HandleFunc("POST /api/geminipro/submit", a.handleGeminiSubmit)
	a.mux.HandleFunc("GET /api/ui/ads", a.handleUIPublicAds)
	a.mux.HandleFunc("GET /api/ui/faq", a.handleUIPublicFAQ)

	// 认证与系统配置
	a.mux.HandleFunc("POST /api/admin/verify", a.handleAdminVerify)
	a.mux.HandleFunc("POST /api/admin/password", a.requireAdmin(a.handleChangePassword))
	a.mux.HandleFunc("GET /api/system/config", a.requireAdmin(a.handleGetConfig))
	a.mux.HandleFunc("POST /api/system/config", a.requireAdmin(a.handleSetConfig))
	a.mux.HandleFunc("GET /api/system/ads", a.requireAdmin(a.handleGetAds))
	a.mux.HandleFunc("POST /api/system/ads", a.requireAdmin(a.handleSetAds))
	a.mux.HandleFunc("POST /api/system/ads/upload", a.requireAdmin(a.handleUploadAdImage))
	a.mux.HandleFunc("GET /api/system/faq", a.requireAdmin(a.handleGetFAQ))
	a.mux.HandleFunc("POST /api/system/faq", a.requireAdmin(a.handleSetFAQ))

	// 后台：概览与类型
	a.mux.HandleFunc("GET /api/redeem/admin/overview", a.requireAdmin(a.handleOverview))
	a.mux.HandleFunc("GET /api/redeem/admin/types", a.requireAdmin(a.handleListTypes))
	a.mux.HandleFunc("POST /api/redeem/admin/types", a.requireAdmin(a.handleCreateType))
	a.mux.HandleFunc("PUT /api/redeem/admin/types/{typeId}", a.requireAdmin(a.handleUpdateType))
	a.mux.HandleFunc("DELETE /api/redeem/admin/types/{typeId}", a.requireAdmin(a.handleDeleteType))

	// 后台：库存
	a.mux.HandleFunc("GET /api/redeem/admin/inventory", a.requireAdmin(a.handleListInventory))
	a.mux.HandleFunc("GET /api/redeem/admin/inventory/selection", a.requireAdmin(a.handleInventorySelection))
	a.mux.HandleFunc("POST /api/redeem/admin/inventory/import", a.requireAdmin(a.handleImportInventory))
	a.mux.HandleFunc("POST /api/redeem/admin/inventory/batch-delete", a.requireAdmin(a.handleInventoryBatchDelete))
	a.mux.HandleFunc("POST /api/redeem/admin/inventory/batch-update", a.requireAdmin(a.handleInventoryBatchUpdate))
	a.mux.HandleFunc("POST /api/redeem/admin/inventory/export", a.requireAdmin(a.handleInventoryExport))
	a.mux.HandleFunc("DELETE /api/redeem/admin/inventory/{inventoryId}", a.requireAdmin(a.handleDeleteInventory))
	a.mux.HandleFunc("POST /api/redeem/admin/inventory/{inventoryId}/status", a.requireAdmin(a.handleInventoryStatus))

	// 后台：卡密
	a.mux.HandleFunc("GET /api/redeem/admin/codes", a.requireAdmin(a.handleListCodes))
	a.mux.HandleFunc("GET /api/redeem/admin/codes/selection", a.requireAdmin(a.handleCodeSelection))
	a.mux.HandleFunc("POST /api/redeem/admin/codes/generate", a.requireAdmin(a.handleGenerateCodes))
	a.mux.HandleFunc("POST /api/redeem/admin/codes/batch-status", a.requireAdmin(a.handleCodeBatchStatus))
	a.mux.HandleFunc("POST /api/redeem/admin/codes/batch-delete", a.requireAdmin(a.handleCodeBatchDelete))
	a.mux.HandleFunc("POST /api/redeem/admin/codes/batch-update", a.requireAdmin(a.handleCodeBatchUpdate))
	a.mux.HandleFunc("POST /api/redeem/admin/codes/export", a.requireAdmin(a.handleCodeExport))
	a.mux.HandleFunc("POST /api/redeem/admin/codes/{codeId}/status", a.requireAdmin(a.handleCodeStatus))
	a.mux.HandleFunc("POST /api/redeem/admin/codes/{codeId}/rollback", a.requireAdmin(a.handleRollbackCode))
	a.mux.HandleFunc("DELETE /api/redeem/admin/codes/{codeId}", a.requireAdmin(a.handleDeleteCode))

	// 后台：兑换记录
	a.mux.HandleFunc("GET /api/redeem/admin/records", a.requireAdmin(a.handleListRecords))
	a.mux.HandleFunc("GET /api/redeem/admin/records/{codeId}", a.requireAdmin(a.handleRecordDetail))

	// 广告图公开访问
	a.mux.HandleFunc("GET "+adUploadPublicPath+"/", a.handleUploadedAsset)

	// 前端静态资源与 SPA 兜底
	a.mux.HandleFunc("/", a.handleStatic)
}

// publicTypeView 对应 serializeRedeemTypeForPublic。
type publicTypeView struct {
	ID                           int64                `json:"id"`
	Slug                         string               `json:"slug"`
	Name                         string               `json:"name"`
	Description                  string               `json:"description"`
	MailProtocol                 string               `json:"mail_protocol"`
	MailProtocols                []string             `json:"mail_protocols"`
	ImportDelimiter              string               `json:"import_delimiter"`
	IsActive                     bool                 `json:"is_active"`
	AvailableInventoryCount      int                  `json:"available_inventory_count"`
	AvailableInventoryByProtocol store.ProtocolCounts `json:"available_inventory_by_protocol"`
	AvailableCodeCount           int                  `json:"available_code_count"`
	RedeemedCount                int                  `json:"redeemed_count"`
	FieldSchema                  []domain.Field       `json:"field_schema"`
}

func toPublicType(view store.RedeemTypeView) publicTypeView {
	protocol := view.MailProtocol
	if protocol == "" {
		protocol = "imap"
	}
	protocols := view.MailProtocols
	if len(protocols) == 0 {
		protocols = []string{protocol}
	}

	fields := make([]domain.Field, 0, len(view.FieldSchema))
	for _, field := range view.FieldSchema {
		fields = append(fields, domain.Field{
			Key:         field.Key,
			Label:       field.Label,
			Required:    field.Required,
			Sensitive:   field.Sensitive,
			Placeholder: field.Placeholder,
		})
	}

	return publicTypeView{
		ID:                           view.ID,
		Slug:                         view.Slug,
		Name:                         view.Name,
		Description:                  view.Description,
		MailProtocol:                 protocol,
		MailProtocols:                protocols,
		ImportDelimiter:              view.ImportDelimiter,
		IsActive:                     view.IsActive,
		AvailableInventoryCount:      view.AvailableInventoryCount,
		AvailableInventoryByProtocol: view.AvailableByProtocol,
		AvailableCodeCount:           view.AvailableCodeCount,
		RedeemedCount:                view.RedeemedCount,
		FieldSchema:                  fields,
	}
}

func (a *API) handleCatalog(w http.ResponseWriter, _ *http.Request) {
	types, err := a.store.ListRedeemTypes(false)
	if err != nil {
		a.fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	items := make([]publicTypeView, 0, len(types))
	for _, item := range types {
		items = append(items, toPublicType(item))
	}
	a.ok(w, map[string]any{"types": items}, "兑换类型获取成功")
}

func (a *API) handleAdminVerify(w http.ResponseWriter, request *http.Request) {
	token := strings.TrimSpace(str(body(request), "token"))
	if token == "" {
		token = strings.TrimSpace(strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer "))
	}
	if a.verifyAdminToken(token) {
		writeJSON(w, http.StatusOK, ok(nil, "验证成功"))
		return
	}
	writeJSON(w, http.StatusOK, fail("令牌无效", nil))
}

func (a *API) handleGetConfig(w http.ResponseWriter, _ *http.Request) {
	config, err := a.store.GetSystemConfig()
	if err != nil {
		a.fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, ok(config, ""))
}

func (a *API) handleSetConfig(w http.ResponseWriter, request *http.Request) {
	payload := body(request)
	limit := intOf(payload, "email_limit")
	if limit < 1 || limit > 50 {
		writeJSON(w, http.StatusOK, fail("邮件限制必须在1-50之间", nil))
		return
	}
	if err := a.store.SetSystemConfigValue("email_limit", strconv.FormatInt(limit, 10)); err != nil {
		writeJSON(w, http.StatusOK, fail(err.Error(), nil))
		return
	}
	writeJSON(w, http.StatusOK, ok(nil, "系统配置更新成功，邮件限制设置为 "+strconv.FormatInt(limit, 10)))
}

func (a *API) handleOverview(w http.ResponseWriter, _ *http.Request) {
	overview, err := a.store.GetAdminOverview()
	if err != nil {
		a.fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	a.ok(w, overview, "兑换系统概览获取成功")
}

// handleUploadedAsset 服务 /uploads/ 下的静态文件（广告图）。
func (a *API) handleUploadedAsset(w http.ResponseWriter, request *http.Request) {
	relative := strings.TrimPrefix(request.URL.Path, adUploadPublicPath+"/")
	if relative == "" || strings.Contains(relative, "..") {
		a.fail(w, http.StatusNotFound, "文件不存在")
		return
	}
	full := filepath.Join(a.cfg.UploadDir, filepath.FromSlash(relative))
	if info, err := os.Stat(full); err != nil || info.IsDir() {
		a.fail(w, http.StatusNotFound, "文件不存在")
		return
	}
	// 用户上传内容一律 nosniff，避免被当成可执行内容解析。
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "public, max-age=604800")
	http.ServeFile(w, request, full)
}

// handleStatic 服务前端产物，未命中的非 /api 路径回落到 index.html。
func (a *API) handleStatic(w http.ResponseWriter, request *http.Request) {
	if strings.HasPrefix(request.URL.Path, "/api/") {
		a.fail(w, http.StatusNotFound, "接口不存在")
		return
	}

	path := strings.TrimPrefix(request.URL.Path, "/")
	if path != "" && !strings.Contains(path, "..") {
		full := filepath.Join(a.cfg.FrontendDistDir, filepath.FromSlash(path))
		if info, err := os.Stat(full); err == nil && !info.IsDir() {
			// 带哈希的产物可以长缓存；其余静态文件（favicon 等）短缓存。
			if strings.HasPrefix(path, "assets/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			} else {
				w.Header().Set("Cache-Control", "public, max-age=3600")
			}
			http.ServeFile(w, request, full)
			return
		}
	}

	indexPath := filepath.Join(a.cfg.FrontendDistDir, "index.html")
	if _, err := os.Stat(indexPath); err != nil {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>前端尚未构建</title></head><body style="font-family: sans-serif; padding: 32px; line-height: 1.7;"><h1>前端尚未构建</h1><p>请先在项目根目录执行 <code>npm --prefix ui run build</code>，然后刷新页面。</p></body></html>`))
		return
	}
	// index.html 引用了带哈希的资源，必须每次校验，否则发版后用户会拿到旧壳子。
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeFile(w, request, indexPath)
}
