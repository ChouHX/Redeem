package httpapi

import (
	"encoding/json"
	"mime/multipart"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// maxAdSlots 与 Node 的 MAX_AD_SLOTS 一致：一行两个，左右各一。
const maxAdSlots = 2

// adAction 是广告按钮。
type adAction struct {
	Label string `json:"label"`
	Href  string `json:"href"`
}

// adSlotItem 是单个广告位。
type adSlotItem struct {
	Enabled       bool     `json:"enabled"`
	Title         string   `json:"title"`
	Description   string   `json:"description"`
	ImageURL      string   `json:"image_url"`
	PrimaryAction adAction `json:"primary_action"`
}

// adSlotConfig 是整块广告配置。
type adSlotConfig struct {
	Enabled bool         `json:"enabled"`
	Slots   []adSlotItem `json:"slots"`
}

var defaultAdSlotItem = adSlotItem{
	Enabled:     true,
	Title:       "自营发卡推荐",
	Description: "本站同步提供多类数字商品，可直接前往发卡网下单。",
	ImageURL:    "",
	PrimaryAction: adAction{
		Label: "进入发卡网",
		Href:  "#",
	},
}

var defaultAdSlot = adSlotConfig{
	Enabled: true,
	Slots: []adSlotItem{
		defaultAdSlotItem,
		{
			Enabled:     true,
			Title:       "合作渠道推荐",
			Description: "更多合作渠道与优惠活动，点击按钮查看详情。",
			ImageURL:    "",
			PrimaryAction: adAction{
				Label: "查看详情",
				Href:  "#",
			},
		},
	},
}

const defaultFAQHTML = `<h2>使用须知</h2>
<ol>
  <li><strong>严禁利用本站购买的账号用于一切非法用途。</strong> 本站只有义务出售，但无法管控使用权。您拥有使用权以后，请务必合法利用，切勿游走法律边缘。</li>
  <li><strong>本站所出售的邮箱主要用于注册接收邮件。</strong> 禁止用于诈骗信息推广、违规信息推广以及其他非法用途。</li>
  <li><strong>一旦本站发现用于非法用途，除封号外，本站将全力配合有关部门予以打击。</strong></li>
</ol>
<h2>Outlook 登录绕过辅助邮箱绑定</h2>
<p>已触发 7 天的号，如果登录网页提示绑定辅助邮箱，可在绑定提示页面保持不关闭，直接在原页面地址栏粘贴以下链接进入邮箱：</p>
<p><a href="https://outlook.live.com/mail/0/" target="_blank" rel="noreferrer">https://outlook.live.com/mail/0/</a></p>`

// objectOf 把 any 收窄成 map。
func objectOf(value any) map[string]any {
	if typed, ok := value.(map[string]any); ok {
		return typed
	}
	return nil
}

// jsString 复现 JS 的 `String(x || fallback || "")`：数字/布尔都转文本，空值走兜底。
func jsString(value any, fallback string) string {
	switch typed := value.(type) {
	case nil:
		return strings.TrimSpace(fallback)
	case string:
		if strings.TrimSpace(typed) == "" {
			return strings.TrimSpace(fallback)
		}
		return strings.TrimSpace(typed)
	case json.Number:
		return strings.TrimSpace(typed.String())
	case bool:
		if !typed {
			return strings.TrimSpace(fallback)
		}
		return "true"
	}
	return strings.TrimSpace(fallback)
}

// truthy 对应 JS 的隐式真值判断。
func truthy(value any) bool {
	switch typed := value.(type) {
	case nil:
		return false
	case string:
		return typed != ""
	case bool:
		return typed
	case json.Number:
		number, err := typed.Float64()
		return err == nil && number != 0
	case float64:
		return typed != 0
	}
	return true
}

// parseBooleanAny 对应 parseBoolean(value, fallback)。
func parseBooleanAny(value any, fallback bool) bool {
	switch typed := value.(type) {
	case bool:
		return typed
	case string:
		if typed == "true" || typed == "1" {
			return true
		}
		if typed == "false" || typed == "0" {
			return false
		}
	case json.Number:
		if typed.String() == "1" {
			return true
		}
		if typed.String() == "0" {
			return false
		}
	}
	return fallback
}

func normalizeAdAction(value any, fallback adAction) adAction {
	source := objectOf(value)
	return adAction{
		Label: jsString(source["label"], fallback.Label),
		Href:  jsString(source["href"], fallback.Href),
	}
}

func normalizeAdSlotItem(value any, fallback adSlotItem) adSlotItem {
	source := objectOf(value)
	return adSlotItem{
		Enabled:       parseBooleanAny(source["enabled"], fallback.Enabled),
		Title:         jsString(source["title"], fallback.Title),
		Description:   jsString(source["description"], fallback.Description),
		ImageURL:      jsString(source["image_url"], fallback.ImageURL),
		PrimaryAction: normalizeAdAction(source["primary_action"], fallback.PrimaryAction),
	}
}

func normalizeAdSlotValue(value any, fallback adSlotConfig) adSlotConfig {
	fallbackSlots := fallback.Slots
	source := objectOf(value)

	rawSlots, hasRawSlots := source["slots"].([]any)
	if !hasRawSlots {
		rawSlots = nil
	}
	legacy := false
	if rawSlots == nil {
		legacy = truthy(source["title"]) || truthy(source["description"]) || truthy(source["image_url"])
	}

	slots := make([]adSlotItem, 0, maxAdSlots)
	for index := 0; index < maxAdSlots; index++ {
		fallbackItem := defaultAdSlotItem
		if index < len(fallbackSlots) {
			fallbackItem = fallbackSlots[index]
		}

		switch {
		case rawSlots != nil:
			var raw any
			if index < len(rawSlots) {
				raw = rawSlots[index]
			}
			slots = append(slots, normalizeAdSlotItem(raw, fallbackItem))
		case legacy && index == 0:
			slots = append(slots, normalizeAdSlotItem(source, fallbackItem))
		case index == 0:
			slots = append(slots, normalizeAdSlotItem(map[string]any{}, fallbackItem))
		default:
			// 迁移旧数据时第二个广告位默认关闭，避免历史站点突然多出一块空白广告。
			slots = append(slots, normalizeAdSlotItem(map[string]any{"enabled": false}, fallbackItem))
		}
	}

	return adSlotConfig{
		Enabled: parseBooleanAny(source["enabled"], fallback.Enabled),
		Slots:   slots,
	}
}

func normalizeSharedAdSlotValue(value any) adSlotConfig {
	source := objectOf(value)
	if shared := source["shared"]; truthy(shared) {
		return normalizeAdSlotValue(shared, defaultAdSlot)
	}
	if redeemTop := source["redeem_top"]; truthy(redeemTop) {
		return normalizeAdSlotValue(redeemTop, defaultAdSlot)
	}
	if mailTop := source["mail_top"]; truthy(mailTop) {
		return normalizeAdSlotValue(mailTop, defaultAdSlot)
	}
	return normalizeAdSlotValue(value, defaultAdSlot)
}

// getAdSlotConfig 读配置；坏数据静默回落到默认值，不让广告位拖垮首页。
func (a *API) getAdSlotConfig() adSlotConfig {
	raw, exists, err := a.store.GetSystemConfigValue("ad_slot")
	if err != nil || !exists || raw == "" {
		raw, exists, err = a.store.GetSystemConfigValue("ad_slots")
	}
	if err != nil || !exists || raw == "" {
		return normalizeSharedAdSlotValue(nil)
	}

	var decoded any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return normalizeSharedAdSlotValue(nil)
	}
	return normalizeSharedAdSlotValue(decoded)
}

func (a *API) saveAdSlotConfig(value any) (adSlotConfig, error) {
	normalized := normalizeSharedAdSlotValue(value)
	encoded, err := json.Marshal(normalized)
	if err != nil {
		return normalized, err
	}
	if err := a.store.SetSystemConfigValue("ad_slot", string(encoded)); err != nil {
		return normalized, err
	}
	return normalized, nil
}

func (a *API) getFAQHTML() string {
	raw, exists, err := a.store.GetSystemConfigValue("faq_html")
	if err != nil || !exists || strings.TrimSpace(raw) == "" {
		return strings.TrimSpace(defaultFAQHTML)
	}
	return strings.TrimSpace(raw)
}

func (a *API) saveFAQHTML(value string) (string, error) {
	normalized := strings.TrimSpace(value)
	if normalized == "" {
		normalized = strings.TrimSpace(defaultFAQHTML)
	}
	if err := a.store.SetSystemConfigValue("faq_html", normalized); err != nil {
		return normalized, err
	}
	return normalized, nil
}

// 图片类型白名单，与 Node 的 AD_IMAGE_MIME_EXTENSIONS 一致。
var adImageExtensions = map[string]string{
	"image/png":                ".png",
	"image/jpeg":               ".jpg",
	"image/jpg":                ".jpg",
	"image/gif":                ".gif",
	"image/webp":               ".webp",
	"image/avif":               ".avif",
	"image/bmp":                ".bmp",
	"image/x-icon":             ".ico",
	"image/vnd.microsoft.icon": ".ico",
}

const (
	adUploadSubdir      = "ads"
	adUploadPublicPath  = "/uploads"
	maxAdImageSizeBytes = 8 << 20
)

// saveAdImage 落盘并返回文件名。
func (a *API) saveAdImage(file multipart.File, header *multipart.FileHeader) (string, int64, string, error) {
	contentType := strings.ToLower(strings.TrimSpace(header.Header.Get("Content-Type")))
	if contentType == "" {
		contentType = strings.ToLower(strings.TrimSpace(header.Header.Get("Content-Type")))
	}
	if _, allowed := adImageExtensions[contentType]; !allowed {
		// 浏览器有时不带 Content-Type，用扩展名兜底。
		ext := strings.ToLower(filepath.Ext(header.Filename))
		if !knownImageExtension(ext) {
			return "", 0, "", &uploadError{message: "仅支持上传 PNG / JPG / GIF / WEBP / AVIF / BMP / ICO 图片"}
		}
		contentType = "image/" + strings.TrimPrefix(ext, ".")
	}

	if header.Size > maxAdImageSizeBytes {
		return "", 0, "", &uploadError{message: "图片过大，请上传 8MB 以内的图片"}
	}

	extension := adImageExtensions[contentType]
	if extension == "" {
		extension = strings.ToLower(filepath.Ext(header.Filename))
	}
	if extension == "" {
		extension = ".png"
	}

	directory := filepath.Join(a.cfg.UploadDir, adUploadSubdir)
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return "", 0, "", err
	}

	filename := "ad-" + timestampMillis() + "-" + randomSuffix(6) + extension
	destination, err := os.Create(filepath.Join(directory, filename))
	if err != nil {
		return "", 0, "", err
	}
	defer destination.Close()

	written, err := destination.ReadFrom(file)
	if err != nil {
		return "", 0, "", err
	}
	return filename, written, contentType, nil
}

func knownImageExtension(ext string) bool {
	for _, known := range adImageExtensions {
		if known == ext {
			return true
		}
	}
	return false
}

type uploadError struct{ message string }

func (e *uploadError) Error() string { return e.message }

func timestampMillis() string {
	return time.Now().UTC().Format("20060102150405")
}

func randomSuffix(length int) string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
	buffer := make([]byte, length)
	seed := time.Now().UnixNano()
	for index := range buffer {
		seed = seed*6364136223846793005 + 1442695040888963407
		buffer[index] = alphabet[(seed>>33)%int64(len(alphabet))]
	}
	return string(buffer)
}
