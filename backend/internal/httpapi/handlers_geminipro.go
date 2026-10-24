package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// geminiUpstream 调上游，返回状态码与已解析的 JSON。
func (a *API) geminiUpstream(ctx context.Context, method, pathname string, query map[string]string, body any) (int, bool, map[string]any, error) {
	target := strings.TrimRight(a.cfg.GeminiProAPIBase, "/") + pathname
	if len(query) > 0 {
		values := url.Values{}
		for key, value := range query {
			values.Set(key, value)
		}
		target += "?" + values.Encode()
	}

	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return 0, false, nil, err
		}
		reader = bytes.NewReader(encoded)
	}

	request, err := http.NewRequestWithContext(ctx, method, target, reader)
	if err != nil {
		return 0, false, nil, err
	}
	request.Header.Set("Accept", "application/json, text/javascript, */*; q=0.01")
	request.Header.Set("X-Requested-With", "XMLHttpRequest")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}

	timeout := a.cfg.GeminiProTimeout
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	client := &http.Client{Timeout: timeout}
	response, err := client.Do(request)
	if err != nil {
		return 0, false, nil, err
	}
	defer response.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	if err != nil {
		return response.StatusCode, response.StatusCode < 300, nil, err
	}

	var payload map[string]any
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &payload)
	}
	return response.StatusCode, response.StatusCode >= 200 && response.StatusCode < 300, payload, nil
}

// handleGeminiTasks 对应 GET /api/geminipro/tasks/:cardCode。
func (a *API) handleGeminiTasks(w http.ResponseWriter, request *http.Request) {
	cardCode := strings.TrimSpace(request.PathValue("cardCode"))
	if cardCode == "" {
		a.fail(w, http.StatusBadRequest, "请输入卡密")
		return
	}

	query := request.URL.Query()
	page := boundedInt(query.Get("page"), 1, 1, 100000)
	pageSize := boundedInt(query.Get("page_size"), 20, 1, 100)

	status, upstreamOK, payload, err := a.geminiUpstream(
		request.Context(), http.MethodGet,
		"/tasks/card/"+url.PathEscape(cardCode),
		map[string]string{"page": strconv.Itoa(page), "page_size": strconv.Itoa(pageSize)},
		nil,
	)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || isTimeoutError(err) {
			a.fail(w, http.StatusGatewayTimeout, "上游服务响应超时，请稍后重试")
			return
		}
		a.fail(w, http.StatusBadGateway, "上游服务调用失败: "+err.Error())
		return
	}

	if !upstreamOK {
		message, _ := payload["message"].(string)
		if message == "" {
			message = "上游服务返回 " + strconv.Itoa(status)
		}
		code := http.StatusBadRequest
		if status == http.StatusNotFound {
			code = http.StatusNotFound
		}
		a.fail(w, code, message)
		return
	}
	if success, exists := payload["success"].(bool); exists && !success {
		message, _ := payload["message"].(string)
		if message == "" {
			message = "查询失败"
		}
		a.fail(w, http.StatusBadRequest, message)
		return
	}

	data := payload["data"]
	if data == nil {
		data = payload
	}
	a.ok(w, data, "任务记录查询成功")
}

// handleGeminiSubmit 对应 POST /api/geminipro/submit。
func (a *API) handleGeminiSubmit(w http.ResponseWriter, request *http.Request) {
	payload := body(request)
	card := strings.TrimSpace(str(payload, "card"))

	accounts := make([]string, 0, 4)
	if rawList, ok := payload["accounts"].([]any); ok {
		for _, item := range rawList {
			if text, ok := item.(string); ok && strings.TrimSpace(text) != "" {
				accounts = append(accounts, strings.TrimSpace(text))
			}
		}
	}

	if card == "" {
		a.fail(w, http.StatusBadRequest, "请输入卡密")
		return
	}
	if len(accounts) == 0 {
		a.fail(w, http.StatusBadRequest, "请至少提供一组账号")
		return
	}
	for _, line := range accounts {
		if len(strings.Split(line, "--")) < 3 {
			a.fail(w, http.StatusBadRequest, "账号格式应为：账号--密码--2FA密钥")
			return
		}
	}

	status, upstreamOK, upstreamPayload, err := a.geminiUpstream(
		request.Context(), http.MethodPost, "/tasks/submit", nil,
		map[string]any{
			"card":      card,
			"accounts":  accounts,
			"timestamp": time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		},
	)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || isTimeoutError(err) {
			a.fail(w, http.StatusGatewayTimeout, "上游服务响应超时，请稍后重试")
			return
		}
		a.fail(w, http.StatusBadGateway, "上游服务调用失败: "+err.Error())
		return
	}

	if !upstreamOK {
		message, _ := upstreamPayload["message"].(string)
		if message == "" {
			message = "上游服务返回 " + strconv.Itoa(status)
		}
		code := http.StatusBadRequest
		if status >= 500 {
			code = http.StatusBadGateway
		}
		a.fail(w, code, message)
		return
	}
	if success, exists := upstreamPayload["success"].(bool); exists && !success {
		message, _ := upstreamPayload["message"].(string)
		if message == "" {
			message = "任务提交失败"
		}
		a.fail(w, http.StatusBadRequest, message)
		return
	}

	data := upstreamPayload["data"]
	if data == nil {
		data = upstreamPayload
	}
	message, _ := upstreamPayload["message"].(string)
	if message == "" {
		message = "已提交 " + strconv.Itoa(len(accounts)) + " 条账号"
	}
	a.ok(w, data, message)
}

func isTimeoutError(err error) bool {
	type timeout interface{ Timeout() bool }
	var candidate timeout
	if errors.As(err, &candidate) {
		return candidate.Timeout()
	}
	return strings.Contains(strings.ToLower(err.Error()), "timeout")
}
