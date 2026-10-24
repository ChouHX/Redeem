package httpapi

import (
	"net/http"
	"strings"

	"github.com/redeem/backend/internal/domain"
)

// handleAccess 对应 POST /api/redeem/access：
// 卡密未兑换就现场兑换，已兑换就直接把账号载入（分页）。
func (a *API) handleAccess(w http.ResponseWriter, request *http.Request) {
	payload := body(request)
	codeText := strings.TrimSpace(str(payload, "code"))
	page := boundedInt(str(payload, "page"), 1, 1, 100000)
	pageSize := boundedInt(str(payload, "page_size"), 10, 1, 100)

	if codeText == "" {
		a.fail(w, http.StatusBadRequest, "请输入兑换码")
		return
	}

	codeInfo, err := a.store.CodeByNormalized(domain.NormalizeRedeemCode(codeText))
	if err != nil {
		a.fail(w, http.StatusBadRequest, err.Error())
		return
	}
	if codeInfo == nil {
		a.fail(w, http.StatusNotFound, "兑换码不存在")
		return
	}
	if !a.ensureRedeemDataAvailable(w, codeInfo) {
		return
	}
	if codeInfo.DerivedStatus == "disabled" {
		a.fail(w, http.StatusBadRequest, "兑换码已禁用")
		return
	}
	if codeInfo.DerivedStatus == "expired" {
		a.fail(w, http.StatusBadRequest, "兑换码已过期")
		return
	}

	if codeInfo.Status == "unused" {
		result, err := a.store.RedeemByCode(
			domain.NormalizeRedeemCode(codeText), requesterIP(request), request.UserAgent())
		if err != nil {
			a.fail(w, http.StatusBadRequest, err.Error())
			return
		}

		records, _, err := a.store.RecordsByCodeIDPaged(result.Code.ID, page, pageSize)
		if err != nil {
			a.fail(w, http.StatusBadRequest, err.Error())
			return
		}
		redeemedAt := ""
		if result.Code.RedeemedAt != nil {
			redeemedAt = *result.Code.RedeemedAt
		}
		data, err := redeemResultPayload(entriesFromRecords(records), map[string]any{
			"source":      "newly_redeemed",
			"code":        result.Code.Code,
			"redeemed_at": redeemedAt,
			"total":       result.RedeemedCount,
			"page":        page,
			"page_size":   pageSize,
		}, domain.RedeemEmailType{
			ID:   result.Type.ID,
			Slug: result.Type.Slug,
			Name: result.Type.Name,
		})
		if err != nil {
			a.fail(w, http.StatusBadRequest, err.Error())
			return
		}
		a.ok(w, data, "兑换码已兑换并载入邮箱")
		return
	}

	records, total, err := a.store.RecordsByCodeIDPaged(codeInfo.ID, page, pageSize)
	if err != nil {
		a.fail(w, http.StatusBadRequest, err.Error())
		return
	}
	redeemedAt := ""
	if codeInfo.RedeemedAt != nil {
		redeemedAt = *codeInfo.RedeemedAt
	}
	data, err := redeemResultPayload(entriesFromRecords(records), map[string]any{
		"source":      "existing",
		"code":        codeInfo.Code,
		"redeemed_at": redeemedAt,
		"total":       total,
		"page":        page,
		"page_size":   pageSize,
	}, domain.RedeemEmailType{
		ID:   codeInfo.TypeID,
		Slug: codeInfo.TypeSlug,
		Name: codeInfo.TypeName,
	})
	if err != nil {
		a.fail(w, http.StatusBadRequest, err.Error())
		return
	}
	a.ok(w, data, "已载入兑换码对应邮箱")
}

// handleQuery 对应 POST /api/redeem/query：只读查询，不触发兑换。
func (a *API) handleQuery(w http.ResponseWriter, request *http.Request) {
	codeText := strings.TrimSpace(str(body(request), "code"))
	if codeText == "" {
		a.fail(w, http.StatusBadRequest, "请输入兑换码")
		return
	}

	codeInfo, err := a.store.CodeByNormalized(domain.NormalizeRedeemCode(codeText))
	if err != nil {
		a.fail(w, http.StatusBadRequest, "订单查询失败")
		return
	}
	if codeInfo == nil {
		a.fail(w, http.StatusNotFound, "兑换码不存在")
		return
	}
	if !a.ensureRedeemDataAvailable(w, codeInfo) {
		return
	}

	records, err := a.store.RecordsByCodeID(codeInfo.ID)
	if err != nil {
		a.fail(w, http.StatusBadRequest, "订单查询失败")
		return
	}
	if len(records) == 0 {
		a.fail(w, http.StatusBadRequest, "该兑换码尚未兑换，暂无订单可查询")
		return
	}

	data, err := redeemResultPayload(entriesFromRecords(records), map[string]any{
		"code":        codeInfo.Code,
		"item_count":  len(records),
		"redeemed_at": records[0].RedeemedAt,
	}, domain.RedeemEmailType{
		ID:   codeInfo.TypeID,
		Slug: codeInfo.TypeSlug,
		Name: codeInfo.TypeName,
	})
	if err != nil {
		a.fail(w, http.StatusBadRequest, "订单查询失败")
		return
	}
	a.ok(w, data, "订单查询成功")
}

// handleExchange 对应 POST /api/redeem/exchange：一次性兑换并返回全部账号。
func (a *API) handleExchange(w http.ResponseWriter, request *http.Request) {
	codeText := strings.TrimSpace(str(body(request), "code"))
	if codeText == "" {
		a.fail(w, http.StatusBadRequest, "请输入兑换码")
		return
	}

	normalized := domain.NormalizeRedeemCode(codeText)
	codeInfo, err := a.store.CodeByNormalized(normalized)
	if err != nil {
		a.fail(w, http.StatusBadRequest, "兑换失败")
		return
	}
	if codeInfo != nil && !a.ensureRedeemDataAvailable(w, codeInfo) {
		return
	}

	result, err := a.store.RedeemByCode(normalized, requesterIP(request), request.UserAgent())
	if err != nil {
		a.fail(w, http.StatusBadRequest, err.Error())
		return
	}

	redeemedAt := ""
	if result.Code.RedeemedAt != nil {
		redeemedAt = *result.Code.RedeemedAt
	}

	meta := map[string]any{
		"record_ids":        result.RecordIDs,
		"quantity":          result.Code.Quantity,
		"redeemed_count":    result.RedeemedCount,
		"redeemed_at":       redeemedAt,
		"code":              result.Code.Code,
		"access_expires_at": a.store.AccessExpiresAt(redeemedAt),
		"access_ttl_hours":  a.store.AccessTTLHours(),
	}
	if result.RecordID != nil {
		meta["record_id"] = *result.RecordID
	} else {
		meta["record_id"] = nil
	}
	if result.RecordIDs == nil {
		meta["record_ids"] = []int64{}
	}

	data, err := redeemResultPayload(entriesFromInventories(result.Inventories), meta, domain.RedeemEmailType{
		ID:              result.Type.ID,
		Slug:            result.Type.Slug,
		Name:            result.Type.Name,
		Description:     result.Type.Description,
		FieldSchema:     result.Type.FieldSchema,
		MailProtocol:    result.Type.MailProtocol,
		MailProtocols:   result.Type.MailProtocols,
		ImportDelimiter: result.Type.ImportDelimiter,
	})
	if err != nil {
		a.fail(w, http.StatusBadRequest, err.Error())
		return
	}
	a.ok(w, data, "兑换成功")
}
