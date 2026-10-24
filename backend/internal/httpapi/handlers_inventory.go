package httpapi

import (
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/redeem/backend/internal/domain"
	"github.com/redeem/backend/internal/store"
)

// parseBool 对应 parseBoolean：兼容 true/false/1/0 字符串。
func parseBool(value string, fallback bool) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "true", "1":
		return true
	case "false", "0":
		return false
	}
	return fallback
}

// inventoryFilterFrom 从查询串构造库存筛选。
func inventoryFilterFrom(request *http.Request) store.InventoryFilter {
	query := request.URL.Query()
	filter := store.InventoryFilter{
		Status:   strings.TrimSpace(query.Get("status")),
		Protocol: strings.TrimSpace(query.Get("protocol")),
		Query:    strings.TrimSpace(query.Get("q")),
	}
	if typeID, err := strconv.ParseInt(strings.TrimSpace(query.Get("type_id")), 10, 64); err == nil && typeID > 0 {
		filter.TypeID = typeID
	}
	return filter
}

func (a *API) handleListInventory(w http.ResponseWriter, request *http.Request) {
	query := request.URL.Query()
	page := boundedInt(query.Get("page"), 1, 1, 100000)
	pageSize := boundedInt(query.Get("page_size"), 10, 1, 100)

	items, total, err := a.store.ListInventoryPaged(inventoryFilterFrom(request), page, pageSize)
	if err != nil {
		a.fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if items == nil {
		items = []store.Inventory{}
	}
	a.ok(w, map[string]any{
		"items":     items,
		"total":     total,
		"page":      page,
		"page_size": pageSize,
	}, "共 "+strconv.Itoa(total)+" 条库存记录")
}

func (a *API) handleInventorySelection(w http.ResponseWriter, request *http.Request) {
	total, err := a.store.InventorySelectionCount(inventoryFilterFrom(request))
	if err != nil {
		a.fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	a.ok(w, map[string]any{"total": total}, "已匹配 "+strconv.Itoa(total)+" 条库存记录")
}

// handleImportInventory 支持 multipart（带文件）与纯 JSON 两种提交。
func (a *API) handleImportInventory(w http.ResponseWriter, request *http.Request) {
	fields, uploaded, err := readUploadOrJSON(request, "file")
	if err != nil {
		a.fail(w, http.StatusBadRequest, err.Error())
		return
	}

	typeID := intOf(fields, "type_id")
	text := strings.TrimSpace(str(fields, "text"))
	if text == "" {
		text = strings.TrimSpace(strings.TrimPrefix(uploaded, "\ufeff"))
	}
	mode := str(fields, "mode")
	if mode == "" {
		mode = "append"
	}
	mailProtocols := parseProtocolList(fields["mail_protocols"])

	if typeID < 1 {
		a.fail(w, http.StatusBadRequest, "请选择兑换类型")
		return
	}
	if text == "" {
		a.fail(w, http.StatusBadRequest, "请输入要导入的库存文本")
		return
	}

	emailType, err := a.store.RedeemTypeByID(typeID)
	if err != nil {
		a.fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if emailType == nil {
		a.fail(w, http.StatusNotFound, "兑换类型不存在")
		return
	}

	parsed := domain.ParseInventoryImportText(text, emailType.FieldSchema, emailType.ImportDelimiter)
	if len(parsed.Items) == 0 {
		writeJSON(w, http.StatusBadRequest, fail("未解析到可导入的库存数据", map[string]any{
			"parse": parsed,
		}))
		return
	}

	imported, err := a.store.ImportInventory(typeID, parsed.Items, mode, mailProtocols)
	if err != nil {
		a.fail(w, http.StatusBadRequest, formatDBError(err, "库存导入失败"))
		return
	}

	protocolUpdateMessage := ""
	if updated := numericField(imported, "protocols_updated_count"); updated > 0 {
		protocolUpdateMessage = "，补全取件协议 " + strconv.Itoa(updated) + " 条"
	}
	added := numericField(imported, "added_count")
	skipped := numericField(imported, "skipped_count")
	message := "库存导入完成，新增 " + strconv.Itoa(added) + " 条" + protocolUpdateMessage +
		"，重复 " + strconv.Itoa(skipped) + " 条"
	if parsed.ErrorCount > 0 {
		message += "，解析错误 " + strconv.Itoa(parsed.ErrorCount) + " 条"
	}

	a.ok(w, map[string]any{
		"type":   emailType,
		"parse":  parsed,
		"import": imported,
	}, message)
}

func (a *API) handleDeleteInventory(w http.ResponseWriter, request *http.Request) {
	inventoryID := pathID(request, "inventoryId")
	if inventoryID == 0 {
		a.fail(w, http.StatusBadRequest, "库存记录不存在")
		return
	}

	deleted, err := a.store.DeleteInventory(inventoryID)
	if err != nil {
		a.fail(w, http.StatusBadRequest, err.Error())
		return
	}
	if !deleted {
		a.fail(w, http.StatusNotFound, "库存记录不存在")
		return
	}
	a.ok(w, map[string]any{"inventory_id": inventoryID}, "库存记录删除成功")
}

func (a *API) handleInventoryStatus(w http.ResponseWriter, request *http.Request) {
	inventoryID := pathID(request, "inventoryId")
	if inventoryID == 0 {
		a.fail(w, http.StatusBadRequest, "库存记录不存在")
		return
	}

	updated, err := a.store.UpdateInventoryStatus(inventoryID, str(body(request), "status"))
	if err != nil {
		a.fail(w, http.StatusBadRequest, err.Error())
		return
	}
	if updated == nil {
		a.fail(w, http.StatusNotFound, "库存记录不存在")
		return
	}
	a.ok(w, updated, "库存状态更新成功")
}

// resolveInventorySelection 对应 resolveFilteredSelection：
// 显式 id 优先，否则按 selection.filters 反查再排除 exclude_ids。
func (a *API) resolveInventorySelection(payload map[string]any) ([]int64, error) {
	if ids := idList(payload, "inventory_ids"); len(ids) > 0 {
		return ids, nil
	}
	if ids := idList(payload, "ids"); len(ids) > 0 {
		return ids, nil
	}
	if ids := directIDList(payload); len(ids) > 0 {
		return ids, nil
	}

	selection, ok := payload["selection"].(map[string]any)
	if !ok {
		return nil, nil
	}
	filters, _ := selection["filters"].(map[string]any)
	excluded := map[int64]struct{}{}
	for _, id := range idList(selection, "exclude_ids") {
		excluded[id] = struct{}{}
	}

	ids, err := a.store.InventoryIDs(inventoryFilterFromMap(filters))
	if err != nil {
		return nil, err
	}
	result := make([]int64, 0, len(ids))
	for _, id := range ids {
		if _, skip := excluded[id]; skip {
			continue
		}
		result = append(result, id)
	}
	return result, nil
}

func (a *API) handleInventoryBatchDelete(w http.ResponseWriter, request *http.Request) {
	ids, err := a.resolveInventorySelection(body(request))
	if err != nil {
		a.fail(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(ids) == 0 {
		a.fail(w, http.StatusBadRequest, "请至少选择一条库存记录")
		return
	}

	deleted, err := a.store.DeleteInventoryBatch(ids)
	if err != nil {
		a.fail(w, http.StatusBadRequest, err.Error())
		return
	}
	a.ok(w, map[string]any{"deleted_count": deleted},
		"已删除 "+strconv.FormatInt(deleted, 10)+" 条库存记录")
}

func (a *API) handleInventoryBatchUpdate(w http.ResponseWriter, request *http.Request) {
	payload := body(request)
	ids, err := a.resolveInventorySelection(payload)
	if err != nil {
		a.fail(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(ids) == 0 {
		a.fail(w, http.StatusBadRequest, "请至少选择一条库存记录")
		return
	}

	typeID := intOf(payload, "type_id")
	if hasValue(payload, "type_id") && (typeID < 1 || typeID > 1000000000) {
		a.fail(w, http.StatusBadRequest, "请选择有效的兑换类型")
		return
	}
	nextStatus := strings.TrimSpace(str(payload, "status"))
	if nextStatus != "" && nextStatus != "available" && nextStatus != "unavailable" {
		a.fail(w, http.StatusBadRequest, "库存状态仅支持可用或不可用")
		return
	}
	if typeID < 1 && nextStatus == "" {
		a.fail(w, http.StatusBadRequest, "请至少指定一个库存修改项")
		return
	}

	updated, err := a.store.UpdateInventoryBatch(ids, typeID, nextStatus)
	if err != nil {
		a.fail(w, http.StatusBadRequest, err.Error())
		return
	}

	updatedCount := numericField(updated, "updated_count")
	skippedCount := numericField(updated, "skipped_count")
	message := "已批量更新 " + strconv.Itoa(updatedCount) + " 条库存记录"
	if skippedCount > 0 {
		message += "，跳过 " + strconv.Itoa(skippedCount) + " 条"
	}
	a.ok(w, updated, message)
}

func (a *API) handleInventoryExport(w http.ResponseWriter, request *http.Request) {
	ids, err := a.resolveInventorySelection(body(request))
	if err != nil {
		a.fail(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(ids) == 0 {
		a.fail(w, http.StatusBadRequest, "请至少选择一条库存记录")
		return
	}

	items, err := a.store.InventoryByIDs(ids)
	if err != nil {
		a.fail(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(items) == 0 {
		a.fail(w, http.StatusNotFound, "未找到可导出的库存记录")
		return
	}

	now := chinaNow()
	lines := make([]string, 0, len(items)+3)
	lines = append(lines, "# Redeem inventory export", "# 导出时间: "+now, "")
	for _, item := range items {
		lines = append(lines, item.SerializedValue)
	}

	filename := "redeem_inventory_" + compactTimestamp(now) + ".txt"
	w.Header().Set("Content-Disposition", "attachment; filename="+filename)
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = io.WriteString(w, strings.Join(lines, "\n"))
}

// readUploadOrJSON 同时支持 multipart/form-data 与 application/json。
// 返回统一的字段表，以及文件内容（若有）。
func readUploadOrJSON(request *http.Request, fileField string) (map[string]any, string, error) {
	contentType := request.Header.Get("Content-Type")
	if !strings.HasPrefix(contentType, "multipart/form-data") {
		return body(request), "", nil
	}

	// 16MB 与 Node 的 multer limits.fileSize 一致。
	if err := request.ParseMultipartForm(16 << 20); err != nil {
		return nil, "", err
	}
	fields := map[string]any{}
	for key, values := range request.MultipartForm.Value {
		if len(values) > 0 {
			fields[key] = values[0]
		}
	}

	file, _, err := request.FormFile(fileField)
	if err != nil {
		return fields, "", nil
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, 32<<20))
	if err != nil {
		return nil, "", err
	}
	return fields, string(raw), nil
}

// directIDList 兼容 Node 的 `req.body` 直接是 id 数组的旧调用。
func directIDList(payload map[string]any) []int64 {
	if len(payload) == 0 {
		return nil
	}
	ids := make([]int64, 0, len(payload))
	for key := range payload {
		parsed, err := strconv.ParseInt(key, 10, 64)
		if err != nil || parsed < 1 {
			return nil
		}
		ids = append(ids, parsed)
	}
	return ids
}

// inventoryFilterFromMap 从 selection.filters 构造筛选。
func inventoryFilterFromMap(filters map[string]any) store.InventoryFilter {
	return store.InventoryFilter{
		TypeID:   intOf(filters, "type_id"),
		Status:   strings.TrimSpace(str(filters, "status")),
		Protocol: strings.TrimSpace(str(filters, "protocol")),
		Query:    strings.TrimSpace(str(filters, "q")),
	}
}

// parseProtocolList 兼容 JSON 数组与逗号分隔字符串。
func parseProtocolList(raw any) []string {
	switch typed := raw.(type) {
	case nil:
		return nil
	case []any:
		items := make([]string, 0, len(typed))
		for _, item := range typed {
			if text, ok := item.(string); ok {
				items = append(items, text)
			}
		}
		return items
	case string:
		text := strings.TrimSpace(typed)
		if text == "" {
			return nil
		}
		if strings.HasPrefix(text, "[") {
			if decoded := decodeJSONStringList(text); decoded != nil {
				return decoded
			}
		}
		return strings.Split(text, ",")
	}
	return nil
}

// hasValue 对应 hasBodyValue：字段存在且去空白后非空。
func hasValue(payload map[string]any, key string) bool {
	value, exists := payload[key]
	if !exists || value == nil {
		return false
	}
	return strings.TrimSpace(str(payload, key)) != ""
}

// numericField 从 map[string]any 里读一个整数，兼容 int / int64 / float64。
func numericField(payload map[string]any, key string) int {
	value, exists := payload[key]
	if !exists || value == nil {
		return 0
	}
	switch typed := value.(type) {
	case int:
		return typed
	case int64:
		return int(typed)
	case float64:
		return int(typed)
	}
	return 0
}

// chinaNow 对应 formatDateTime：固定按 Asia/Shanghai 输出。
func chinaNow() string {
	zone, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		zone = time.FixedZone("CST", 8*3600)
	}
	return time.Now().In(zone).Format("2006-01-02 15:04:05")
}

// compactTimestamp 复现 `replace(/[-: ]/g,"").slice(0,15)`。
func compactTimestamp(value string) string {
	replacer := strings.NewReplacer("-", "", ":", "", " ", "")
	compact := replacer.Replace(value)
	if len(compact) > 15 {
		return compact[:15]
	}
	return compact
}
