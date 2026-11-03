package httpapi

import (
	"net/http"

	"github.com/redeem/backend/internal/store"
)

// 兑换业务已经迁到 HStore，本站只保留「已兑换数据」的查询与取件。
// 新兑换一律引导到下面这个地址，避免同一个码在两个站点各兑一次。
const migratedRedeemURL = "https://opcuu.com/redeem"

// guardRedeemedOnly 拦截本站的新兑换：只有已兑换（redeemed）的卡密还允许继续取件。
// 未使用、已禁用、不存在的卡密都提示去新站点，避免用户在本站白等。
func (a *API) guardRedeemedOnly(w http.ResponseWriter, code *store.Code) bool {
	if code == nil {
		a.fail(w, http.StatusNotFound,
			"兑换码不存在；本站兑换服务已迁移，请前往 "+migratedRedeemURL+" 兑换")
		return false
	}
	if code.Status == "redeemed" {
		return true
	}
	a.fail(w, http.StatusConflict,
		"本站兑换服务已迁移，请前往 "+migratedRedeemURL+" 兑换")
	return false
}
