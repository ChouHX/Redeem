package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/redeem/backend/internal/store"
)

// decodeJSONStringList 解析 `["imap","graph"]` 这种字符串数组。
func decodeJSONStringList(text string) []string {
	var decoded []string
	if err := json.Unmarshal([]byte(text), &decoded); err != nil {
		return nil
	}
	return decoded
}

// codeFilterFrom 从查询串构造卡密筛选。
func codeFilterFrom(request *http.Request) store.CodeFilter {
	query := request.URL.Query()
	filter := store.CodeFilter{
		Status: strings.TrimSpace(query.Get("status")),
		Query:  strings.TrimSpace(query.Get("q")),
	}
	if typeID, err := strconv.ParseInt(strings.TrimSpace(query.Get("type_id")), 10, 64); err == nil && typeID > 0 {
		filter.TypeID = typeID
	}
	filter.MinQuantity = boundedInt(query.Get("min_quantity"), 0, 0, 1<<31-1)
	filter.MaxQuantity = boundedInt(query.Get("max_quantity"), 0, 0, 1<<31-1)
	return filter
}

func (a *API) handleListCodes(w http.ResponseWriter, request *http.Request) {
	query := request.URL.Query()
	page := boundedInt(query.Get("page"), 1, 1, 100000)
	pageSize := boundedInt(query.Get("page_size"), 10, 1, 100)

	items, total, err := a.store.ListCodesPaged(codeFilterFrom(request), page, pageSize)
	if err != nil {
		a.fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if items == nil {
		items = []store.Code{}
	}
	a.ok(w, map[string]any{
		"items":     items,
		"total":     total,
		"page":      page,
		"page_size": pageSize,
	}, "共 "+strconv.Itoa(total)+" 个兑换码")
}

func (a *API) handleCodeSelection(w http.ResponseWriter, request *http.Request) {
	total, err := a.store.CodeSelectionCount(codeFilterFrom(request))
	if err != nil {
		a.fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	a.ok(w, map[string]any{"total": total}, "已匹配 "+strconv.Itoa(total)+" 个兑换码")
}

func (a *API) handleGenerateCodes(w http.ResponseWriter, request *http.Request) {
	payload := body(request)
	typeID := intOf(payload, "type_id")
	if typeID < 1 {
		a.fail(w, http.StatusBadRequest, "请选择兑换类型")
		return
	}

	expiresAt, err := normalizeExpiresAt(str(payload, "expires_at"))
	if err != nil {
		a.fail(w, http.StatusBadRequest, err.Error())
		return
	}

	codes, err := a.store.CreateCodes(
		typeID,
		boundedInt(str(payload, "count"), 1, 1, 1<<31-1),
		boundedInt(str(payload, "quantity"), 1, 1, 1<<31-1),
		str(payload, "note"),
		expiresAt,
	)
	if err != nil {
		a.fail(w, http.StatusBadRequest, formatDBError(err, "兑换码生成失败"))
		return
	}
	a.ok(w, map[string]any{"items": codes},
		"已生成 "+strconv.Itoa(len(codes))+" 个兑换码")
}

// normalizeExpiresAt 对应 normalizeExpiresAt：统一转成 ISO 串，空值返回 nil。
func normalizeExpiresAt(value string) (*string, error) {
	text := strings.TrimSpace(value)
	if text == "" {
		return nil, nil
	}
	// 前端传的多是 ISO 或 "YYYY-MM-DD HH:MM:SS"，两种都认。
	if parsed, ok := parseFlexibleTime(text); ok {
		iso := parsed.UTC().Format("2006-01-02T15:04:05.000Z")
		return &iso, nil
	}
	return nil, errInvalidTime
}

var errInvalidTime = &timeFormatError{}

type timeFormatError struct{}

func (*timeFormatError) Error() string { return "过期时间格式不正确" }

func (a *API) handleCodeStatus(w http.ResponseWriter, request *http.Request) {
	codeID := pathID(request, "codeId")
	if codeID == 0 {
		a.fail(w, http.StatusBadRequest, "兑换码不存在")
		return
	}

	updated, err := a.store.UpdateCodeStatus(codeID, str(body(request), "status"))
	if err != nil {
		a.fail(w, http.StatusBadRequest, err.Error())
		return
	}
	if updated == nil {
		a.fail(w, http.StatusNotFound, "兑换码不存在")
		return
	}
	a.ok(w, updated, "兑换码状态更新成功")
}

func (a *API) handleRollbackCode(w http.ResponseWriter, request *http.Request) {
	codeID := pathID(request, "codeId")
	if codeID == 0 {
		a.fail(w, http.StatusBadRequest, "兑换码不存在")
		return
	}

	result, err := a.store.RollbackCode(codeID)
	if err != nil {
		a.fail(w, http.StatusBadRequest, err.Error())
		return
	}
	if result == nil {
		a.fail(w, http.StatusNotFound, "兑换码不存在")
		return
	}
	a.ok(w, result, "卡密已销毁，"+strconv.Itoa(numericField(result, "restored_inventory_count"))+
		" 个账号已重新入库为可用状态")
}

func (a *API) handleDeleteCode(w http.ResponseWriter, request *http.Request) {
	codeID := pathID(request, "codeId")
	if codeID == 0 {
		a.fail(w, http.StatusBadRequest, "兑换码不存在")
		return
	}

	deleted, err := a.store.DeleteCode(codeID)
	if err != nil {
		a.fail(w, http.StatusBadRequest, err.Error())
		return
	}
	if !deleted {
		a.fail(w, http.StatusNotFound, "兑换码不存在")
		return
	}
	a.ok(w, map[string]any{"code_id": codeID}, "兑换码删除成功")
}

// resolveCodeSelection 对应 resolveFilteredSelection（卡密版）。
func (a *API) resolveCodeSelection(payload map[string]any) ([]int64, error) {
	if ids := idList(payload, "code_ids"); len(ids) > 0 {
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

	ids, err := a.store.CodeIDs(codeFilterFromMap(filters))
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

func codeFilterFromMap(filters map[string]any) store.CodeFilter {
	return store.CodeFilter{
		TypeID:      intOf(filters, "type_id"),
		Status:      strings.TrimSpace(str(filters, "status")),
		Query:       strings.TrimSpace(str(filters, "q")),
		MinQuantity: int(intOf(filters, "min_quantity")),
		MaxQuantity: int(intOf(filters, "max_quantity")),
	}
}

func (a *API) handleCodeBatchStatus(w http.ResponseWriter, request *http.Request) {
	ids, err := a.resolveCodeSelection(body(request))
	if err != nil {
		a.fail(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(ids) == 0 {
		a.fail(w, http.StatusBadRequest, "请至少选择一个兑换码")
		return
	}

	updated, err := a.store.UpdateCodeStatusBatch(ids, str(body(request), "status"))
	if err != nil {
		a.fail(w, http.StatusBadRequest, err.Error())
		return
	}

	actionText := "恢复"
	if str(body(request), "status") == "disabled" {
		actionText = "禁用"
	}
	updatedCount := numericField(updated, "updated_count")
	skippedCount := numericField(updated, "skipped_count")
	message := "已" + actionText + " " + strconv.Itoa(updatedCount) + " 个兑换码"
	if skippedCount > 0 {
		message += "，跳过 " + strconv.Itoa(skippedCount) + " 个"
	}
	a.ok(w, updated, message)
}

func (a *API) handleCodeBatchDelete(w http.ResponseWriter, request *http.Request) {
	ids, err := a.resolveCodeSelection(body(request))
	if err != nil {
		a.fail(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(ids) == 0 {
		a.fail(w, http.StatusBadRequest, "请至少选择一个兑换码")
		return
	}

	deleted, err := a.store.DeleteCodeBatch(ids)
	if err != nil {
		a.fail(w, http.StatusBadRequest, err.Error())
		return
	}

	message := "已删除 " + strconv.Itoa(deleted.DeletedCount) + " 个兑换码"
	if deleted.SkippedCount > 0 {
		message += "，跳过 " + strconv.Itoa(deleted.SkippedCount) + " 个"
	}
	a.ok(w, deleted, message)
}

func (a *API) handleCodeBatchUpdate(w http.ResponseWriter, request *http.Request) {
	payload := body(request)
	ids, err := a.resolveCodeSelection(payload)
	if err != nil {
		a.fail(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(ids) == 0 {
		a.fail(w, http.StatusBadRequest, "请至少选择一个兑换码")
		return
	}

	typeID := intOf(payload, "type_id")
	if hasValue(payload, "type_id") && (typeID < 1 || typeID > 1000000000) {
		a.fail(w, http.StatusBadRequest, "请选择有效的兑换类型")
		return
	}
	quantity := intOf(payload, "quantity")
	if hasValue(payload, "quantity") && quantity < 1 {
		a.fail(w, http.StatusBadRequest, "卡密可兑数量需为大于 0 的整数")
		return
	}
	if typeID < 1 && quantity < 1 {
		a.fail(w, http.StatusBadRequest, "请至少指定一个卡密修改项")
		return
	}

	updated, err := a.store.UpdateCodeBatch(ids, typeID, int(quantity))
	if err != nil {
		a.fail(w, http.StatusBadRequest, err.Error())
		return
	}

	updatedCount := numericField(updated, "updated_count")
	skippedCount := numericField(updated, "skipped_count")
	message := "已批量更新 " + strconv.Itoa(updatedCount) + " 个兑换码"
	if skippedCount > 0 {
		message += "，跳过 " + strconv.Itoa(skippedCount) + " 个"
	}
	a.ok(w, updated, message)
}

func (a *API) handleCodeExport(w http.ResponseWriter, request *http.Request) {
	payload := body(request)
	ids, err := a.resolveCodeSelection(payload)
	if err != nil {
		a.fail(w, http.StatusBadRequest, err.Error())
		return
	}

	hasExplicitSelection := payload["selection"] != nil || len(idList(payload, "code_ids")) > 0
	var items []store.Code
	if hasExplicitSelection {
		items, err = a.store.CodesByIDs(ids)
	} else {
		items, err = a.store.CodesForExport(store.CodeFilter{
			TypeID:      intOf(payload, "type_id"),
			Status:      strings.TrimSpace(str(payload, "status")),
			Query:       strings.TrimSpace(str(payload, "q")),
			MinQuantity: int(intOf(payload, "min_quantity")),
			MaxQuantity: int(intOf(payload, "max_quantity")),
		})
	}
	if err != nil {
		a.fail(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(items) == 0 {
		a.fail(w, http.StatusNotFound, "未找到可导出的兑换码")
		return
	}

	lines := make([]string, 0, len(items))
	for _, item := range items {
		lines = append(lines, item.Code)
	}

	filenameTag := "filtered"
	if len(ids) > 0 {
		filenameTag = "selected"
	} else if status := sanitizeExportCell(str(payload, "status")); status != "" {
		filenameTag = strings.ToLower(status)
	}

	filename := "redeem_codes_" + filenameTag + "_" + compactTimestamp(chinaNow()) + ".txt"
	w.Header().Set("Content-Disposition", "attachment; filename="+filename)
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = io.WriteString(w, strings.Join(lines, "\n"))
}

// sanitizeExportCell 对应 sanitizeExportCell：换行与制表符压成空格。
func sanitizeExportCell(value string) string {
	replaced := strings.ReplaceAll(value, "\r\n", " ")
	replaced = strings.ReplaceAll(replaced, "\n", " ")
	replaced = strings.ReplaceAll(replaced, "\t", " ")
	return strings.TrimSpace(replaced)
}

func (a *API) handleListRecords(w http.ResponseWriter, request *http.Request) {
	query := request.URL.Query()
	page := boundedInt(query.Get("page"), 1, 1, 100000)
	pageSize := boundedInt(query.Get("page_size"), 10, 1, 100)
	typeID, _ := strconv.ParseInt(strings.TrimSpace(query.Get("type_id")), 10, 64)

	groups, total, err := a.store.ListRecordGroups(typeID, strings.TrimSpace(query.Get("q")), page, pageSize)
	if err != nil {
		a.fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if groups == nil {
		groups = []store.RecordGroup{}
	}
	a.ok(w, map[string]any{
		"items":     groups,
		"total":     total,
		"page":      page,
		"page_size": pageSize,
	}, "共 "+strconv.Itoa(total)+" 条兑换记录")
}

func (a *API) handleRecordDetail(w http.ResponseWriter, request *http.Request) {
	codeID := pathID(request, "codeId")
	if codeID == 0 {
		a.fail(w, http.StatusBadRequest, "兑换记录不存在")
		return
	}

	items, err := a.store.RecordsByCodeID(codeID)
	if err != nil {
		a.fail(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(items) == 0 {
		a.fail(w, http.StatusNotFound, "兑换记录不存在")
		return
	}

	first := items[0]
	a.ok(w, map[string]any{
		"code_id":     codeID,
		"code":        first.Code,
		"type_id":     first.TypeID,
		"type_name":   first.TypeName,
		"type_slug":   first.TypeSlug,
		"redeemed_at": first.RedeemedAt,
		"item_count":  len(items),
		"items":       items,
	}, "兑换记录详情获取成功")
}

// parseFlexibleTime 兼容 ISO 与 "YYYY-MM-DD HH:MM:SS"。
// Node 用 new Date(str) 解析，纯日期串会被当成 UTC 零点。
func parseFlexibleTime(value string) (time.Time, bool) {
	layouts := []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02T15:04:05.000Z0700",
		"2006-01-02T15:04:05",
		"2006-01-02 15:04:05",
		"2006-01-02T15:04",
		"2006-01-02 15:04",
		"2006-01-02",
	}
	for _, layout := range layouts {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed, true
		}
	}
	return time.Time{}, false
}
