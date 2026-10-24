package httpapi

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/redeem/backend/internal/mail"
)

// providerConfig 把进程配置映射成取件参数。
func (a *API) providerConfig() mail.ProviderConfig {
	return mail.ProviderConfig{
		TokenURL:        a.cfg.TokenURL,
		ClientID:        a.cfg.ClientID,
		IMAPOAuthScope:  a.cfg.IMAPOAuthScope,
		GraphOAuthScope: a.cfg.GraphOAuthScope,
		GraphAPIBase:    a.cfg.GraphAPIBase,
		IMAPServer:      a.cfg.IMAPServer,
		IMAPPort:        a.cfg.IMAPPort,
		InboxFolderName: a.cfg.InboxFolderName,
		JunkFolderName:  a.cfg.JunkFolderName,
		SocketTimeout:   a.cfg.IMAPTimeout,
	}
}

// parseMailFolder 对应 parseMailFolder：只接受 inbox / spam / junk。
func parseMailFolder(value string) (string, error) {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if normalized == "" || normalized == "inbox" {
		return "inbox", nil
	}
	if normalized == "spam" || normalized == "junk" {
		return "spam", nil
	}
	return "", errors.New("folder 仅支持 inbox 或 spam")
}

// tempAccount 对应 normalizeTempMailboxPayload。
func (a *API) tempAccount(payload map[string]any) (mail.Account, error) {
	email := strings.TrimSpace(str(payload, "email"))
	refreshToken := strings.TrimSpace(str(payload, "refresh_token"))
	if email == "" || refreshToken == "" {
		return mail.Account{}, errors.New("邮箱和 Refresh Token 为必填项")
	}

	clientID := str(payload, "client_id")
	if clientID == "" {
		clientID = a.cfg.ClientID
	}
	protocol := strings.ToLower(strings.TrimSpace(str(payload, "mail_protocol")))
	if protocol != "graph" {
		protocol = "imap"
	}

	return mail.Account{
		Email:        email,
		Password:     str(payload, "password"),
		ClientID:     clientID,
		RefreshToken: refreshToken,
		Protocol:     protocol,
	}, nil
}

// handleTempMessages 对应 POST /api/temp-messages：取前 N 封带正文的邮件。
func (a *API) handleTempMessages(w http.ResponseWriter, request *http.Request) {
	payload := body(request)
	account, err := a.tempAccount(payload)
	if err != nil {
		writeJSON(w, http.StatusOK, fail("获取邮件失败: "+err.Error(), nil))
		return
	}
	top := boundedInt(str(payload, "top"), 1, 1, 50)
	folder, err := parseMailFolder(str(payload, "folder"))
	if err != nil {
		writeJSON(w, http.StatusOK, fail("获取邮件失败: "+err.Error(), nil))
		return
	}

	messages, _, err := mail.WithContent(a.providerConfig(), account, top, folder)
	if err != nil {
		writeJSON(w, http.StatusOK, fail("获取邮件失败: "+err.Error(), nil))
		return
	}
	writeJSON(w, http.StatusOK, ok(messages, ""))
}

// handleMailboxList 对应 POST /api/mailboxes/temp/messages。
func (a *API) handleMailboxList(w http.ResponseWriter, request *http.Request) {
	payload := body(request)
	account, err := a.tempAccount(payload)
	if err != nil {
		a.fail(w, http.StatusBadRequest, "获取邮件列表失败: "+err.Error())
		return
	}
	folder, err := parseMailFolder(str(payload, "folder"))
	if err != nil {
		a.fail(w, http.StatusBadRequest, "获取邮件列表失败: "+err.Error())
		return
	}

	page := boundedInt(str(payload, "page"), 1, 1, 100000)
	pageSize := boundedInt(str(payload, "page_size"), a.cfg.DefaultEmailLimit, 1, 100)
	if pageSize < 1 {
		pageSize = 10
	}
	includeBodies := true
	if hasValue(payload, "include_bodies") {
		includeBodies = parseBool(str(payload, "include_bodies"), true)
	} else if hasValue(payload, "includeBodies") {
		includeBodies = parseBool(str(payload, "includeBodies"), true)
	}

	result, err := mail.List(a.providerConfig(), account, folder, page, pageSize, includeBodies)
	if err != nil {
		a.fail(w, http.StatusBadRequest, "获取邮件列表失败: "+err.Error())
		return
	}

	a.ok(w, map[string]any{
		"email":     result.Email,
		"folder":    result.Folder,
		"total":     result.Total,
		"page":      result.Page,
		"page_size": result.PageSize,
		"items":     result.Items,
	}, "共 "+strconv.Itoa(result.Total)+" 封邮件")
}

// handleMailboxDetail 对应 POST /api/mailboxes/temp/messages/:messageId。
func (a *API) handleMailboxDetail(w http.ResponseWriter, request *http.Request) {
	payload := body(request)
	account, err := a.tempAccount(payload)
	if err != nil {
		a.fail(w, http.StatusBadRequest, "获取邮件详情失败: "+err.Error())
		return
	}
	folder, err := parseMailFolder(str(payload, "folder"))
	if err != nil {
		a.fail(w, http.StatusBadRequest, "获取邮件详情失败: "+err.Error())
		return
	}

	messageID := strings.TrimSpace(request.PathValue("messageId"))
	result, err := mail.Detail(a.providerConfig(), account, folder, messageID)
	if err != nil {
		a.fail(w, http.StatusBadRequest, "获取邮件详情失败: "+err.Error())
		return
	}

	a.ok(w, map[string]any{
		"email":  result.Email,
		"folder": result.Folder,
		"item":   result.Item,
	}, "邮件详情获取成功")
}
