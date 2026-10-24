package httpapi

import (
	"net/http"
	"strings"
)

func (a *API) handleUIPublicAds(w http.ResponseWriter, _ *http.Request) {
	a.ok(w, a.getAdSlotConfig(), "广告位配置获取成功")
}

func (a *API) handleUIPublicFAQ(w http.ResponseWriter, _ *http.Request) {
	a.ok(w, map[string]any{"html": a.getFAQHTML()}, "FAQ 配置获取成功")
}

func (a *API) handleGetAds(w http.ResponseWriter, _ *http.Request) {
	a.ok(w, a.getAdSlotConfig(), "广告位配置获取成功")
}

func (a *API) handleSetAds(w http.ResponseWriter, request *http.Request) {
	updated, err := a.saveAdSlotConfig(body(request))
	if err != nil {
		a.fail(w, http.StatusBadRequest, err.Error())
		return
	}
	a.ok(w, updated, "广告位配置更新成功")
}

func (a *API) handleGetFAQ(w http.ResponseWriter, _ *http.Request) {
	a.ok(w, map[string]any{"html": a.getFAQHTML()}, "FAQ 配置获取成功")
}

func (a *API) handleSetFAQ(w http.ResponseWriter, request *http.Request) {
	html, err := a.saveFAQHTML(str(body(request), "html"))
	if err != nil {
		a.fail(w, http.StatusBadRequest, err.Error())
		return
	}
	a.ok(w, map[string]any{"html": html}, "FAQ 配置更新成功")
}

// handleUploadAdImage 接收 multipart 的 file 字段，落盘后回传公开地址。
func (a *API) handleUploadAdImage(w http.ResponseWriter, request *http.Request) {
	if !strings.HasPrefix(request.Header.Get("Content-Type"), "multipart/form-data") {
		a.fail(w, http.StatusBadRequest, "请选择要上传的图片文件")
		return
	}
	// 多留 1MB 给表单其它字段，实际大小在 saveAdImage 里按 header.Size 卡。
	if err := request.ParseMultipartForm(maxAdImageSizeBytes + (1 << 20)); err != nil {
		a.fail(w, http.StatusBadRequest, "图片过大，请上传 8MB 以内的图片")
		return
	}

	file, header, err := request.FormFile("file")
	if err != nil {
		a.fail(w, http.StatusBadRequest, "请选择要上传的图片文件")
		return
	}
	defer file.Close()

	filename, size, mimetype, err := a.saveAdImage(file, header)
	if err != nil {
		a.fail(w, http.StatusBadRequest, err.Error())
		return
	}

	a.ok(w, map[string]any{
		"image_url": adUploadPublicPath + "/" + adUploadSubdir + "/" + filename,
		"filename":  filename,
		"size":      size,
		"mimetype":  mimetype,
	}, "图片上传成功")
}

// handleChangePassword 改管理密码，写入 system_config.admin_token。
func (a *API) handleChangePassword(w http.ResponseWriter, request *http.Request) {
	payload := body(request)
	currentToken := str(payload, "current_token")
	nextToken := strings.TrimSpace(str(payload, "new_token"))

	if !a.verifyAdminToken(currentToken) {
		a.fail(w, http.StatusBadRequest, "当前管理密码不正确")
		return
	}
	if len([]rune(nextToken)) < 4 {
		a.fail(w, http.StatusBadRequest, "新密码长度不能少于 4 位")
		return
	}
	if err := a.store.SetSystemConfigValue("admin_token", nextToken); err != nil {
		a.fail(w, http.StatusBadRequest, err.Error())
		return
	}
	a.ok(w, map[string]any{"token": nextToken}, "管理密码修改成功")
}
