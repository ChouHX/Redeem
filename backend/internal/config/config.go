// Package config 对齐 src/config.js 的环境变量语义。
// 变量名保持 NODE_ 前缀，方便同一个 .env 直接复用、灰度期两套后端共存。
package config

import (
	"bufio"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Config 是进程启动时一次性解析出来的只读配置。
type Config struct {
	RootDir         string
	FrontendDistDir string
	DBPath          string
	UploadDir       string

	Port      int
	Host      string
	AdminPath string
	LogLevel  string

	AdminToken      string
	ClientID        string
	TokenURL        string
	GraphAPIBase    string
	GraphOAuthScope string
	IMAPOAuthScope  string

	GeminiProAPIBase string
	GeminiProTimeout time.Duration

	// 取件通道
	IMAPServer      string
	IMAPPort        int
	InboxFolderName string
	JunkFolderName  string
	IMAPTimeout     time.Duration

	RedeemAccessTTL   time.Duration
	DefaultEmailLimit int
}

// Load 读取 .env（若存在）后解析环境变量。
func Load() Config {
	loadDotEnv(".env")

	root, err := os.Getwd()
	if err != nil {
		root = "."
	}

	return Config{
		RootDir:         root,
		FrontendDistDir: envString("FRONTEND_DIST_DIR", filepath.Join(root, "ui", "dist")),
		DBPath:          envString("DB_PATH", filepath.Join(root, "outlook_manager.db")),
		UploadDir:       envString("UPLOAD_DIR", filepath.Join(root, "data", "uploads")),

		Port:      envInt("NODE_BACKEND_PORT", 5002),
		Host:      envString("NODE_BACKEND_HOST", "0.0.0.0"),
		AdminPath: normalizeRoutePath(envString("ADMIN_PATH", "/admin"), "/admin"),
		LogLevel:  strings.ToLower(envString("LOG_LEVEL", "info")),

		AdminToken:      envString("ADMIN_TOKEN", "admin123"),
		ClientID:        envString("CLIENT_ID", "dbc8e03a-b00c-46bd-ae65-b683e7707cb0"),
		TokenURL:        envString("TOKEN_URL", "https://login.microsoftonline.com/consumers/oauth2/v2.0/token"),
		GraphAPIBase:    strings.TrimRight(envString("GRAPH_API_BASE", "https://graph.microsoft.com/v1.0"), "/"),
		GraphOAuthScope: envString("GRAPH_OAUTH_SCOPE", "https://graph.microsoft.com/.default"),
		IMAPOAuthScope:  envString("IMAP_OAUTH_SCOPE", "https://outlook.office.com/IMAP.AccessAsUser.All offline_access"),

		GeminiProAPIBase: strings.TrimRight(envString("GEMINI_PRO_API_BASE", "https://1688ai.vip"), "/"),
		GeminiProTimeout: time.Duration(envInt("GEMINI_PRO_API_TIMEOUT_MS", 15000)) * time.Millisecond,

		IMAPServer:      envString("IMAP_SERVER", "outlook.live.com"),
		IMAPPort:        envInt("IMAP_PORT", 993),
		InboxFolderName: envString("INBOX_FOLDER_NAME", "INBOX"),
		JunkFolderName:  envString("JUNK_FOLDER_NAME", "Junk"),
		IMAPTimeout:     time.Duration(envInt("IMAP_SOCKET_TIMEOUT", 60000)) * time.Millisecond,

		RedeemAccessTTL:   accessTTL(),
		DefaultEmailLimit: envInt("DEFAULT_EMAIL_LIMIT", 1),
	}
}

// accessTTL 对应 config.js 的 `Math.max(60s, N || 24h)`。
func accessTTL() time.Duration {
	raw := os.Getenv("REDEEM_ACCESS_TTL_MS")
	ttl := 24 * time.Hour
	if parsed, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64); err == nil && parsed != 0 {
		ttl = time.Duration(parsed) * time.Millisecond
	}
	if ttl < time.Minute {
		ttl = time.Minute
	}
	return ttl
}

func envString(key, fallback string) string {
	if value, ok := os.LookupEnv(key); ok && strings.TrimSpace(value) != "" {
		return value
	}
	return fallback
}

func envInt(key string, fallback int) int {
	raw, ok := os.LookupEnv(key)
	if !ok {
		return fallback
	}
	parsed, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil {
		return fallback
	}
	return parsed
}

// normalizeRoutePath 与 config.js 同义：补前导斜杠、压重复斜杠、去尾斜杠。
func normalizeRoutePath(value, fallback string) string {
	raw := strings.TrimSpace(value)
	if raw == "" {
		return fallback
	}
	joined := "/" + raw
	for strings.Contains(joined, "//") {
		joined = strings.ReplaceAll(joined, "//", "/")
	}
	joined = strings.TrimSuffix(joined, "/")
	if joined == "" || joined == "/" {
		return fallback
	}
	return joined
}

// loadDotEnv 是 dotenv 的最小替代：只支持 KEY=VALUE、# 注释、可选引号。
// 已存在的环境变量优先，不覆盖。
func loadDotEnv(path string) {
	file, err := os.Open(path)
	if err != nil {
		return
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		key, value, found := strings.Cut(line, "=")
		if !found {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if len(value) >= 2 {
			if (value[0] == '"' && value[len(value)-1] == '"') ||
				(value[0] == '\'' && value[len(value)-1] == '\'') {
				value = value[1 : len(value)-1]
			}
		}
		if key == "" {
			continue
		}
		if _, exists := os.LookupEnv(key); exists {
			continue
		}
		_ = os.Setenv(key, value)
	}
}
