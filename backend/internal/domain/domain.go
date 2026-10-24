// Package domain 逐函数移植 src/redeem.js。
// 这里的字符串、顺序、去重规则都按原实现来，保证 Go 与 Node 输出逐字节一致
// （发卡场景下 formatted_line 错一个字符就等于发错货）。
package domain

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"strings"
)

// MailProtocols 是受支持的取件协议，顺序即对外展示顺序。
var MailProtocols = []string{"imap", "graph"}

const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

// Field 是 field_schema 的一项。
type Field struct {
	Key         string `json:"key"`
	Label       string `json:"label"`
	Required    bool   `json:"required"`
	Sensitive   bool   `json:"sensitive"`
	Placeholder string `json:"placeholder"`
}

// RawLineFieldSchema 是默认类型使用的单字段 schema。
var RawLineFieldSchema = []Field{
	{Key: "raw_line", Label: "原始数据", Required: true, Placeholder: "整行数据"},
}

// DefaultFieldSchema 用于老数据兜底（field_schema 解析失败时）。
var DefaultFieldSchema = []Field{
	{Key: "account", Label: "账号", Required: true, Placeholder: "邮箱账号"},
	{Key: "password", Label: "密码", Sensitive: true, Placeholder: "登录密码"},
	{Key: "oauth2id", Label: "OAuth2 ID", Placeholder: "OAuth2 Client ID"},
	{Key: "refreshtoken", Label: "Refresh Token", Required: true, Sensitive: true, Placeholder: "Refresh Token"},
}

// DefaultRedeemEmailType 对应 DEFAULT_REDEEM_EMAIL_TYPE。
var DefaultRedeemEmailType = RedeemEmailType{
	Slug:            "outlook-oauth",
	Name:            "Outlook OAuth 邮箱",
	Description:     "默认邮箱兑换类型，按整行数据保存，兼容 Outlook OAuth 四段配置。",
	MailProtocol:    "imap",
	MailProtocols:   []string{"imap"},
	ImportDelimiter: "----",
	IsActive:        true,
	FieldSchema:     RawLineFieldSchema,
}

// RedeemEmailType 是兑换类型的完整视图。
type RedeemEmailType struct {
	ID              int64    `json:"id"`
	Slug            string   `json:"slug"`
	Name            string   `json:"name"`
	Description     string   `json:"description"`
	FieldSchema     []Field  `json:"field_schema"`
	MailProtocol    string   `json:"mail_protocol"`
	MailProtocols   []string `json:"mail_protocols"`
	ImportDelimiter string   `json:"import_delimiter"`
	IsActive        bool     `json:"is_active"`
	CreatedAt       string   `json:"created_at"`
	UpdatedAt       string   `json:"updated_at"`
}

// Payload 保持字段顺序的键值对集合。
// 用有序结构而不是 map，是为了让 JSON 输出与 Node 的字段顺序一致。
type Payload struct {
	pairs []kv
}

type kv struct {
	Key   string
	Value string
}

// NewPayload 由有序键值构造。
func NewPayload(pairs ...kv) Payload { return Payload{pairs: pairs} }

// RawLinePayload 是最常见的形态：只有一个 raw_line。
func RawLinePayload(rawLine string) Payload {
	return Payload{pairs: []kv{{Key: "raw_line", Value: rawLine}}}
}

// Get 取字段值，缺失返回空串。
func (p Payload) Get(key string) string {
	for _, item := range p.pairs {
		if item.Key == key {
			return item.Value
		}
	}
	return ""
}

// Set 写入或覆盖字段值。
func (p *Payload) Set(key, value string) {
	for index := range p.pairs {
		if p.pairs[index].Key == key {
			p.pairs[index].Value = value
			return
		}
	}
	p.pairs = append(p.pairs, kv{Key: key, Value: value})
}

// Keys 返回全部字段名，用于 payloadToSearchText。
func (p Payload) Keys() []string {
	keys := make([]string, 0, len(p.pairs))
	for _, item := range p.pairs {
		keys = append(keys, item.Key)
	}
	return keys
}

// Len 返回字段数量。
func (p Payload) Len() int { return len(p.pairs) }

// MarshalJSON 按写入顺序输出。
func (p Payload) MarshalJSON() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteByte('{')
	for index, item := range p.pairs {
		if index > 0 {
			buf.WriteByte(',')
		}
		key, err := json.Marshal(item.Key)
		if err != nil {
			return nil, err
		}
		value, err := json.Marshal(item.Value)
		if err != nil {
			return nil, err
		}
		buf.Write(key)
		buf.WriteByte(':')
		buf.Write(value)
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

// UnmarshalJSON 保留输入顺序，便于原样回写。
func (p *Payload) UnmarshalJSON(data []byte) error {
	var ordered []struct {
		Key   string
		Value json.RawMessage
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := decoder.Decode(&ordered); err != nil {
		return err
	}
	p.pairs = p.pairs[:0]
	for _, item := range ordered {
		var str string
		if err := json.Unmarshal(item.Value, &str); err != nil {
			str = strings.Trim(string(item.Value), `"`)
		}
		p.pairs = append(p.pairs, kv{Key: item.Key, Value: str})
	}
	return nil
}

var (
	slugStripper    = regexp.MustCompile(`[^a-z0-9]+`)
	slugTrimmer     = regexp.MustCompile(`^-+|-+$`)
	fieldKeyStrip   = regexp.MustCompile(`[^a-z0-9_]+`)
	fieldKeyTrim    = regexp.MustCompile(`^_+|_+$`)
	fieldKeyPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)
)

func contains(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}

// NormalizeMailProtocol 把任意输入收敛成 imap / graph。
func NormalizeMailProtocol(value, fallback string) string {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if normalized == "" {
		normalized = strings.ToLower(strings.TrimSpace(fallback))
	}
	if normalized == "" {
		normalized = "imap"
	}
	if contains(MailProtocols, normalized) {
		return normalized
	}
	return "imap"
}

// NormalizeMailProtocols 支持 JSON 数组字符串、逗号分隔字符串与切片三种输入，
// 去重保序后只保留合法协议；全部非法时回落到 fallback。
func NormalizeMailProtocols(value any, fallback []string) []string {
	var raw []string
	switch typed := value.(type) {
	case nil:
	case []string:
		raw = typed
	case string:
		text := strings.TrimSpace(typed)
		if text != "" {
			var parsed []string
			if err := json.Unmarshal([]byte(text), &parsed); err == nil {
				raw = parsed
			} else {
				raw = strings.Split(text, ",")
			}
		}
	}

	seen := map[string]struct{}{}
	normalized := make([]string, 0, len(raw))
	for _, item := range raw {
		candidate := strings.ToLower(strings.TrimSpace(item))
		if !contains(MailProtocols, candidate) {
			continue
		}
		if _, exists := seen[candidate]; exists {
			continue
		}
		seen[candidate] = struct{}{}
		normalized = append(normalized, candidate)
	}
	if len(normalized) > 0 {
		return normalized
	}

	fallbackSeen := map[string]struct{}{}
	result := make([]string, 0, len(fallback))
	for _, item := range fallback {
		candidate := NormalizeMailProtocol(item, "imap")
		if _, exists := fallbackSeen[candidate]; exists {
			continue
		}
		fallbackSeen[candidate] = struct{}{}
		result = append(result, candidate)
	}
	if len(result) == 0 {
		return []string{"imap"}
	}
	return result
}

// InferPickupProtocolsFromPayload 判断账号凭据本身能否支撑两种协议。
func InferPickupProtocolsFromPayload(payload Payload) []string {
	rawLine := strings.TrimSpace(payload.Get("raw_line"))
	if rawLine != "" {
		parts := strings.Split(rawLine, "----")
		trimmed := make([]string, len(parts))
		for index, item := range parts {
			trimmed[index] = strings.TrimSpace(item)
		}
		if len(trimmed) >= 4 && trimmed[2] != "" && trimmed[3] != "" {
			return []string{"imap", "graph"}
		}
		return nil
	}

	clientID := strings.TrimSpace(payload.Get("oauth2id"))
	if clientID == "" {
		clientID = strings.TrimSpace(payload.Get("client_id"))
	}
	refreshToken := strings.TrimSpace(payload.Get("refreshtoken"))
	if refreshToken == "" {
		refreshToken = strings.TrimSpace(payload.Get("refresh_token"))
	}
	if clientID != "" && refreshToken != "" {
		return []string{"imap", "graph"}
	}
	return nil
}

// ResolvePickupProtocols = 类型允许范围 ∩ (入库元数据 ∪ 账号凭据能力)。
func ResolvePickupProtocols(emailType RedeemEmailType, payload Payload, storedProtocols []string) []string {
	allowed := NormalizeMailProtocols(emailType.MailProtocols, []string{emailType.MailProtocol})
	stored := NormalizeMailProtocols(storedProtocols, nil)
	capable := NormalizeMailProtocols(InferPickupProtocolsFromPayload(payload), nil)

	merged := make([]string, 0, len(stored)+len(capable))
	seen := map[string]struct{}{}
	for _, group := range [][]string{stored, capable} {
		for _, protocol := range group {
			if !contains(allowed, protocol) {
				continue
			}
			if _, exists := seen[protocol]; exists {
				continue
			}
			seen[protocol] = struct{}{}
			merged = append(merged, protocol)
		}
	}
	if len(merged) > 0 {
		return merged
	}
	return allowed
}

// RedeemResultItem 是发给用户的单条结果。
type RedeemResultItem struct {
	MailProtocols []string `json:"mail_protocols"`
	FormattedLine string   `json:"formatted_line"`
	Payload       Payload  `json:"payload"`
}

// RedeemResultType 是结果里的类型视图（语义是「允许范围」）。
type RedeemResultType struct {
	ID              *int64   `json:"id"`
	Slug            string   `json:"slug"`
	Name            string   `json:"name"`
	Description     string   `json:"description"`
	ImportDelimiter string   `json:"import_delimiter"`
	MailProtocol    string   `json:"mail_protocol"`
	MailProtocols   []string `json:"mail_protocols"`
}

// FormatRedeemResultItem 只保留取件端需要的三样东西。
func FormatRedeemResultItem(emailType RedeemEmailType, payload Payload, storedProtocols []string) (RedeemResultItem, error) {
	fields := ParseFieldSchemaFromSlice(emailType.FieldSchema)
	delimiter := emailType.ImportDelimiter
	if delimiter == "" {
		delimiter = "----"
	}
	normalized, err := NormalizeInventoryPayload(fields, payload)
	if err != nil {
		return RedeemResultItem{}, err
	}

	return RedeemResultItem{
		MailProtocols: ResolvePickupProtocols(emailType, normalized, storedProtocols),
		FormattedLine: SerializeInventoryPayload(fields, normalized, delimiter),
		Payload:       normalized,
	}, nil
}

// FormatRedeemResultType 收敛类型视图。
func FormatRedeemResultType(emailType RedeemEmailType) RedeemResultType {
	protocols := NormalizeMailProtocols(emailType.MailProtocols, []string{emailType.MailProtocol})
	var id *int64
	if emailType.ID != 0 {
		value := emailType.ID
		id = &value
	}
	delimiter := emailType.ImportDelimiter
	if delimiter == "" {
		delimiter = "----"
	}
	return RedeemResultType{
		ID:              id,
		Slug:            emailType.Slug,
		Name:            emailType.Name,
		Description:     emailType.Description,
		ImportDelimiter: delimiter,
		MailProtocol:    protocols[0],
		MailProtocols:   protocols,
	}
}

// CollectResultMailProtocols 汇总所有结果条目的协议，回落到类型范围。
func CollectResultMailProtocols(items []RedeemResultItem, emailType RedeemEmailType) []string {
	typeProtocols := NormalizeMailProtocols(emailType.MailProtocols, []string{emailType.MailProtocol})
	flattened := make([]string, 0, len(items))
	for _, item := range items {
		flattened = append(flattened, NormalizeMailProtocols(item.MailProtocols, nil)...)
	}
	return NormalizeMailProtocols(flattened, typeProtocols)
}

// CollectRedeemedMailProtocols 与上面同义，入参是每条库存的协议列表。
func CollectRedeemedMailProtocols(storedProtocols [][]string, emailType RedeemEmailType) []string {
	typeProtocols := NormalizeMailProtocols(emailType.MailProtocols, []string{emailType.MailProtocol})
	flattened := make([]string, 0, len(storedProtocols))
	for _, protocols := range storedProtocols {
		flattened = append(flattened, NormalizeMailProtocols(protocols, nil)...)
	}
	return NormalizeMailProtocols(flattened, typeProtocols)
}

func normalizeFieldKey(value string, index int) string {
	fallback := fmt.Sprintf("field_%d", index+1)
	text := strings.TrimSpace(value)
	if text == "" {
		text = fallback
	}
	normalized := fieldKeyTrim.ReplaceAllString(
		fieldKeyStrip.ReplaceAllString(strings.ToLower(text), "_"), "",
	)
	if normalized == "" {
		return fallback
	}
	return normalized
}

// NormalizeFieldSchema 校验并规范化 field_schema。
func NormalizeFieldSchema(raw []Field) ([]Field, error) {
	if len(raw) == 0 {
		return nil, errors.New("请至少配置一个字段")
	}

	seen := map[string]struct{}{}
	normalized := make([]Field, 0, len(raw))
	for index, field := range raw {
		key := normalizeFieldKey(field.Key, index)
		if !fieldKeyPattern.MatchString(key) {
			return nil, fmt.Errorf("字段键名不合法: %s", field.Key)
		}
		if _, exists := seen[key]; exists {
			return nil, fmt.Errorf("字段键名重复: %s", key)
		}
		seen[key] = struct{}{}

		label := strings.TrimSpace(field.Label)
		if label == "" {
			label = key
		}
		normalized = append(normalized, Field{
			Key:         key,
			Label:       label,
			Required:    field.Required,
			Sensitive:   field.Sensitive,
			Placeholder: strings.TrimSpace(field.Placeholder),
		})
	}
	return normalized, nil
}

// ParseFieldSchema 解析存库的 field_schema JSON 字符串。
// 解析失败回落到 DefaultFieldSchema，与 Node 的 safeJsonParse 行为一致。
func ParseFieldSchema(rawSchema string) []Field {
	trimmed := strings.TrimSpace(rawSchema)
	if trimmed == "" {
		return DefaultFieldSchema
	}
	var parsed []Field
	if err := json.Unmarshal([]byte(trimmed), &parsed); err != nil || len(parsed) == 0 {
		return DefaultFieldSchema
	}
	normalized, err := NormalizeFieldSchema(parsed)
	if err != nil {
		return DefaultFieldSchema
	}
	return normalized
}

// ParseFieldSchemaFromSlice 已经是结构化数据时直接规范化。
func ParseFieldSchemaFromSlice(raw []Field) []Field {
	if len(raw) == 0 {
		return DefaultFieldSchema
	}
	normalized, err := NormalizeFieldSchema(raw)
	if err != nil {
		return DefaultFieldSchema
	}
	return normalized
}

// IsRawLineSchema 判断是否为单字段整行 schema。
func IsRawLineSchema(fields []Field) bool {
	return len(fields) == 1 && fields[0].Key == "raw_line"
}

// Slugify 把名称转成 slug。
func Slugify(value string) string {
	lowered := strings.ToLower(strings.TrimSpace(value))
	slug := slugTrimmer.ReplaceAllString(slugStripper.ReplaceAllString(lowered, "-"), "")
	if len(slug) > 64 {
		slug = slug[:64]
	}
	return slug
}

// NormalizeRedeemEmailTypeInput 校验类型配置。
func NormalizeRedeemEmailTypeInput(payload map[string]any) (RedeemEmailType, error) {
	name := strings.TrimSpace(stringValue(payload["name"]))
	if name == "" {
		return RedeemEmailType{}, errors.New("类型名称不能为空")
	}

	slug := Slugify(stringValue(payload["slug"]))
	if slug == "" {
		slug = Slugify(name)
	}
	if slug == "" {
		return RedeemEmailType{}, errors.New("类型标识不能为空")
	}

	var fields []Field
	if rawFields, ok := payload["field_schema"]; ok && rawFields != nil {
		fields = decodeFieldSchema(rawFields)
	}
	if len(fields) == 0 {
		fields = RawLineFieldSchema
	}
	normalizedFields, err := NormalizeFieldSchema(fields)
	if err != nil {
		return RedeemEmailType{}, err
	}

	delimiter := strings.TrimSpace(stringValue(payload["import_delimiter"]))
	if delimiter == "" {
		delimiter = "----"
	}

	protocols := NormalizeMailProtocols(payload["mail_protocols"], []string{
		NormalizeMailProtocol(stringValue(payload["mail_protocol"]), "imap"),
	})

	return RedeemEmailType{
		Slug:            slug,
		Name:            name,
		Description:     strings.TrimSpace(stringValue(payload["description"])),
		MailProtocols:   protocols,
		MailProtocol:    protocols[0],
		FieldSchema:     normalizedFields,
		ImportDelimiter: delimiter,
		IsActive:        boolValue(payload["is_active"], true),
	}, nil
}

func decodeFieldSchema(raw any) []Field {
	switch typed := raw.(type) {
	case []Field:
		return typed
	case []any:
		encoded, err := json.Marshal(typed)
		if err != nil {
			return nil
		}
		var fields []Field
		if err := json.Unmarshal(encoded, &fields); err != nil {
			return nil
		}
		return fields
	case string:
		if strings.TrimSpace(typed) == "" {
			return nil
		}
		var fields []Field
		if err := json.Unmarshal([]byte(typed), &fields); err != nil {
			return nil
		}
		return fields
	}
	return nil
}

func stringValue(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case bool:
		if typed {
			return "true"
		}
		return "false"
	case float64:
		return strconvFormatFloat(typed)
	case int:
		return fmt.Sprintf("%d", typed)
	case int64:
		return fmt.Sprintf("%d", typed)
	case json.Number:
		return typed.String()
	default:
		return fmt.Sprintf("%v", typed)
	}
}

func strconvFormatFloat(value float64) string {
	if value == float64(int64(value)) {
		return fmt.Sprintf("%d", int64(value))
	}
	return fmt.Sprintf("%v", value)
}

// boolValue 对应 redeem.js 的 toBoolean：0/"0"/"false" 为假，1/"1"/"true" 为真。
func boolValue(value any, fallback bool) bool {
	switch typed := value.(type) {
	case nil:
		return fallback
	case bool:
		return typed
	case float64:
		if typed == 0 {
			return false
		}
		if typed == 1 {
			return true
		}
		return fallback
	case int:
		if typed == 0 {
			return false
		}
		if typed == 1 {
			return true
		}
		return fallback
	case string:
		switch strings.TrimSpace(strings.ToLower(typed)) {
		case "0", "false":
			return false
		case "1", "true":
			return true
		}
		return fallback
	}
	return fallback
}

// NormalizeRedeemCode 去空格、转大写。
func NormalizeRedeemCode(code string) string {
	upper := strings.ToUpper(strings.TrimSpace(code))
	return strings.Join(strings.Fields(upper), "")
}

// GenerateRedeemCode 生成 XXXX-XXXX-XXXX 形式的卡密。
func GenerateRedeemCode() string {
	parts := make([]string, 3)
	for index := range parts {
		parts[index] = randomChunk(4)
	}
	return strings.Join(parts, "-")
}

func randomChunk(length int) string {
	builder := strings.Builder{}
	builder.Grow(length)
	max := big.NewInt(int64(len(codeAlphabet)))
	for index := 0; index < length; index++ {
		value, err := rand.Int(rand.Reader, max)
		if err != nil {
			// crypto/rand 失败在实践中不可见，但仍不阻塞发码：退回时间派生的伪随机。
			builder.WriteByte(codeAlphabet[fallbackIndex(length)])
			continue
		}
		builder.WriteByte(codeAlphabet[value.Int64()])
	}
	return builder.String()
}

var fallbackCounter uint64

func fallbackIndex(length int) int {
	fallbackCounter++
	return int((fallbackCounter*1103515245 + 12345) % uint64(len(codeAlphabet)*length))
}

// PayloadToSearchText 与 Node 的 payloadToSearchText 同义。
func PayloadToSearchText(payload Payload) string {
	parts := make([]string, 0, len(payload.pairs))
	for _, item := range payload.pairs {
		value := strings.ToLower(strings.TrimSpace(item.Value))
		if value == "" {
			continue
		}
		parts = append(parts, value)
	}
	return strings.Join(parts, " ")
}

// SerializeInventoryPayload 按 schema 顺序拼成一行。
func SerializeInventoryPayload(fieldSchema []Field, payload Payload, delimiter string) string {
	fields := ParseFieldSchemaFromSlice(fieldSchema)
	if IsRawLineSchema(fields) {
		return strings.TrimSpace(payload.Get("raw_line"))
	}
	separator := delimiter
	if separator == "" {
		separator = "----"
	}
	values := make([]string, 0, len(fields))
	for _, field := range fields {
		values = append(values, strings.TrimSpace(payload.Get(field.Key)))
	}
	return strings.Join(values, separator)
}

// NormalizeInventoryPayload 按 schema 取值并校验必填。
func NormalizeInventoryPayload(fieldSchema []Field, payload Payload) (Payload, error) {
	fields := ParseFieldSchemaFromSlice(fieldSchema)
	if IsRawLineSchema(fields) {
		rawLine := strings.TrimSpace(payload.Get("raw_line"))
		if rawLine == "" {
			rawLine = strings.TrimSpace(payload.Get("line"))
		}
		if rawLine == "" {
			return Payload{}, errors.New("整行数据不能为空")
		}
		return RawLinePayload(rawLine), nil
	}

	normalized := Payload{}
	for _, field := range fields {
		value := strings.TrimSpace(payload.Get(field.Key))
		if field.Required && value == "" {
			return Payload{}, fmt.Errorf("字段 %s 为必填项", field.Label)
		}
		normalized.Set(field.Key, value)
	}
	return normalized, nil
}

// ImportItem 是导入解析出的一条库存。
type ImportItem struct {
	Payload         Payload `json:"payload"`
	SerializedValue string  `json:"serialized_value"`
	SearchText      string  `json:"search_text"`
}

// ImportResult 是导入解析的汇总。
type ImportResult struct {
	Items       []ImportItem `json:"items"`
	ParsedCount int          `json:"parsed_count"`
	ErrorCount  int          `json:"error_count"`
	Errors      []string     `json:"errors"`
}

// ParseInventoryImportText 逐行解析导入文本。
func ParseInventoryImportText(text string, fieldSchema []Field, delimiter string) ImportResult {
	fields := ParseFieldSchemaFromSlice(fieldSchema)
	sep := delimiter
	if sep == "" {
		sep = "----"
	}

	result := ImportResult{Items: []ImportItem{}, Errors: []string{}}
	lines := splitLines(text)
	for index, rawLine := range lines {
		line := strings.TrimSpace(rawLine)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		if IsRawLineSchema(fields) {
			result.Items = append(result.Items, ImportItem{
				Payload:         RawLinePayload(line),
				SerializedValue: line,
				SearchText:      strings.ToLower(line),
			})
			continue
		}

		parts := strings.Split(line, sep)
		for i := range parts {
			parts[i] = strings.TrimSpace(parts[i])
		}
		if len(parts) < len(fields) {
			result.Errors = append(result.Errors,
				fmt.Sprintf("第 %d 行字段数量不足，期望 %d 个字段", index+1, len(fields)))
			continue
		}

		payload := Payload{}
		for fieldIndex, field := range fields {
			var value string
			if fieldIndex == len(fields)-1 {
				value = strings.TrimSpace(strings.Join(parts[fieldIndex:], sep))
			} else {
				value = strings.TrimSpace(parts[fieldIndex])
			}
			payload.Set(field.Key, value)
		}

		normalized, err := NormalizeInventoryPayload(fields, payload)
		if err != nil {
			result.Errors = append(result.Errors,
				fmt.Sprintf("第 %d 行格式错误: %s", index+1, err.Error()))
			continue
		}

		result.Items = append(result.Items, ImportItem{
			Payload:         normalized,
			SerializedValue: SerializeInventoryPayload(fields, normalized, sep),
			SearchText:      PayloadToSearchText(normalized),
		})
	}

	result.ParsedCount = len(result.Items)
	result.ErrorCount = len(result.Errors)
	return result
}

// splitLines 对齐 JS 的 split(/\r?\n/)。
func splitLines(text string) []string {
	normalized := strings.ReplaceAll(text, "\r\n", "\n")
	normalized = strings.ReplaceAll(normalized, "\r", "\n")
	return strings.Split(normalized, "\n")
}

// FormatRedeemedInventory 是兑换结果里单个库存的完整视图（后台/取件页用）。
func FormatRedeemedInventory(emailType RedeemEmailType, payload Payload) (map[string]any, error) {
	fields := ParseFieldSchemaFromSlice(emailType.FieldSchema)
	delimiter := emailType.ImportDelimiter
	if delimiter == "" {
		delimiter = "----"
	}
	normalized, err := NormalizeInventoryPayload(fields, payload)
	if err != nil {
		return nil, err
	}
	protocols := NormalizeMailProtocols(emailType.MailProtocols, []string{emailType.MailProtocol})

	fieldViews := make([]map[string]any, 0, len(fields))
	for _, field := range fields {
		fieldViews = append(fieldViews, map[string]any{
			"key":       field.Key,
			"label":     field.Label,
			"required":  field.Required,
			"sensitive": field.Sensitive,
			"value":     normalized.Get(field.Key),
		})
	}

	var typeID *int64
	if emailType.ID != 0 {
		value := emailType.ID
		typeID = &value
	}

	return map[string]any{
		"mail_protocols": protocols,
		"type": map[string]any{
			"id":               typeID,
			"slug":             emailType.Slug,
			"name":             emailType.Name,
			"description":      emailType.Description,
			"mail_protocol":    protocols[0],
			"mail_protocols":   protocols,
			"import_delimiter": delimiter,
		},
		"fields":         fieldViews,
		"payload":        normalized,
		"formatted_line": SerializeInventoryPayload(fields, normalized, delimiter),
	}, nil
}

// MailboxCredentials 是从整行数据里解析出的 OAuth 凭据。
type MailboxCredentials struct {
	Email        string `json:"email"`
	Password     string `json:"password"`
	ClientID     string `json:"client_id"`
	RefreshToken string `json:"refresh_token"`
}

// ParseMailboxAccountLine 解析 email----password----client_id----refresh_token。
func ParseMailboxAccountLine(rawLine, fallbackClientID string) *MailboxCredentials {
	text := strings.TrimSpace(rawLine)
	if !strings.Contains(text, "----") {
		return nil
	}

	parts := strings.Split(text, "----")
	for index := range parts {
		parts[index] = strings.TrimSpace(parts[index])
	}
	if len(parts) < 2 {
		return nil
	}

	if len(parts) >= 4 {
		clientID := parts[2]
		if clientID == "" {
			clientID = fallbackClientID
		}
		return &MailboxCredentials{
			Email:        parts[0],
			Password:     parts[1],
			ClientID:     clientID,
			RefreshToken: strings.Join(parts[3:], "----"),
		}
	}

	return &MailboxCredentials{
		Email:        parts[0],
		Password:     "",
		ClientID:     fallbackClientID,
		RefreshToken: strings.Join(parts[1:], "----"),
	}
}
