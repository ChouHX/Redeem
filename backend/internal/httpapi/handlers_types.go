package httpapi

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/redeem/backend/internal/domain"
	"github.com/redeem/backend/internal/store"
)

// pathID 取路径里的正整数 id，非法时返回 0。
func pathID(request *http.Request, name string) int64 {
	raw := strings.TrimSpace(request.PathValue(name))
	if raw == "" {
		return 0
	}
	parsed, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || parsed < 1 {
		return 0
	}
	return parsed
}

// formatDBError 对应 formatDbErrorMessage：把唯一约束冲突翻成人话。
func formatDBError(err error, fallback string) string {
	message := ""
	if err != nil {
		message = err.Error()
	}
	if message == "" {
		message = fallback
	}
	if strings.Contains(message, "redeem_email_types.slug") {
		return "类型标识已存在，请更换后重试"
	}
	if strings.Contains(message, "redeem_codes.code") ||
		strings.Contains(message, "redeem_codes.normalized_code") {
		return "兑换码生成冲突，请重试"
	}
	return message
}

func (a *API) handleListTypes(w http.ResponseWriter, request *http.Request) {
	includeInactive := parseBool(request.URL.Query().Get("include_inactive"), false)
	types, err := a.store.ListRedeemTypes(includeInactive)
	if err != nil {
		a.fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if types == nil {
		types = []store.RedeemTypeView{}
	}
	a.ok(w, map[string]any{"items": types},
		"共 "+strconv.Itoa(len(types))+" 个兑换类型")
}

func (a *API) handleCreateType(w http.ResponseWriter, request *http.Request) {
	input, err := domain.NormalizeRedeemEmailTypeInput(body(request))
	if err != nil {
		a.fail(w, http.StatusBadRequest, err.Error())
		return
	}

	created, err := a.store.CreateRedeemType(input)
	if err != nil {
		a.fail(w, http.StatusBadRequest, formatDBError(err, "兑换类型创建失败"))
		return
	}
	a.ok(w, created, "兑换类型创建成功")
}

func (a *API) handleUpdateType(w http.ResponseWriter, request *http.Request) {
	typeID := pathID(request, "typeId")
	if typeID == 0 {
		a.fail(w, http.StatusBadRequest, "兑换类型不存在")
		return
	}

	current, err := a.store.RedeemTypeByID(typeID)
	if err != nil {
		a.fail(w, http.StatusBadRequest, err.Error())
		return
	}
	if current == nil {
		a.fail(w, http.StatusNotFound, "兑换类型不存在")
		return
	}

	input, err := domain.NormalizeRedeemEmailTypeInput(body(request))
	if err != nil {
		a.fail(w, http.StatusBadRequest, err.Error())
		return
	}

	updated, err := a.store.UpdateRedeemType(typeID, input)
	if err != nil {
		a.fail(w, http.StatusBadRequest, formatDBError(err, "兑换类型更新失败"))
		return
	}
	if updated == nil {
		updated = current
	}
	a.ok(w, updated, "兑换类型更新成功")
}

func (a *API) handleDeleteType(w http.ResponseWriter, request *http.Request) {
	typeID := pathID(request, "typeId")
	if typeID == 0 {
		a.fail(w, http.StatusBadRequest, "兑换类型不存在")
		return
	}

	deleted, err := a.store.DeleteRedeemType(typeID)
	if err != nil {
		a.fail(w, http.StatusBadRequest, err.Error())
		return
	}
	if deleted == nil {
		a.fail(w, http.StatusNotFound, "兑换类型不存在")
		return
	}

	a.ok(w, deleted, "兑换类型“"+deleted.Type.Name+"”已删除，同时删除 "+
		strconv.FormatInt(deleted.DeletedInventoryCount, 10)+" 条库存、"+
		strconv.FormatInt(deleted.DeletedCodeCount, 10)+" 个兑换码和 "+
		strconv.FormatInt(deleted.DeletedRecordCount, 10)+" 条兑换记录")
}
