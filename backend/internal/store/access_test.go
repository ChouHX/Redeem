package store

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/redeem/backend/internal/config"
)

// openTemp 打开一个临时库，库文件落在 t.TempDir() 里，测试结束自动清理。
func openTemp(t *testing.T, cfg config.Config) *Store {
	t.Helper()
	if cfg.DBPath == "" {
		cfg.DBPath = filepath.Join(t.TempDir(), "test.db")
	}
	st, err := Open(cfg)
	if err != nil {
		t.Fatalf("打开测试库失败: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

// 默认配置（未设置 REDEEM_ACCESS_TTL_MS）必须是不限期：
// 迁移过来的老订单可能是一年前的，仍然要能查询和取件。
func TestAccessIsUnlimitedByDefault(t *testing.T) {
	t.Setenv("REDEEM_ACCESS_TTL_MS", "")

	cfg := config.Load()
	if !cfg.RedeemAccessUnlimited {
		t.Fatalf("默认应为不限期，实际 RedeemAccessUnlimited=false (ttl=%v)", cfg.RedeemAccessTTL)
	}
	if cfg.RedeemAccessTTL != 0 {
		t.Fatalf("默认 TTL 应为 0，实际 %v", cfg.RedeemAccessTTL)
	}

	st := openTemp(t, cfg)

	if st.AccessExpired("2020-01-01 00:00:00") {
		t.Fatal("不限期时一年前的兑换不应判定为过期")
	}
	if got := st.AccessExpiresAt("2020-01-01 00:00:00"); got != nil {
		t.Fatalf("不限期时 access_expires_at 应为 nil，实际 %v", *got)
	}
	if got := st.AccessTTLHours(); got != nil {
		t.Fatalf("不限期时 access_ttl_hours 应为 nil，实际 %v", *got)
	}
	if !st.AccessUnlimited() {
		t.Fatal("AccessUnlimited 应为 true")
	}
}

// 显式设置窗口时，旧的 24 小时语义仍然保留，方便回滚。
func TestAccessWindowStillWorksWhenExplicitlyConfigured(t *testing.T) {
	t.Setenv("REDEEM_ACCESS_TTL_MS", "86400000")

	cfg := config.Load()
	if cfg.RedeemAccessUnlimited {
		t.Fatal("显式设置 TTL 后不应是不限期")
	}
	if cfg.RedeemAccessTTL != 24*time.Hour {
		t.Fatalf("TTL 应为 24h，实际 %v", cfg.RedeemAccessTTL)
	}

	st := openTemp(t, cfg)

	old := time.Now().Add(-25 * time.Hour).UTC().Format("2006-01-02 15:04:05")
	if !st.AccessExpired(old) {
		t.Fatal("25 小时前的兑换在 24h 窗口下应判定为过期")
	}

	fresh := time.Now().UTC().Format("2006-01-02 15:04:05")
	if st.AccessExpired(fresh) {
		t.Fatal("刚兑换的记录不应判定为过期")
	}

	if got := st.AccessTTLHours(); got == nil || *got != 24 {
		t.Fatalf("access_ttl_hours 应为 24，实际 %v", got)
	}
}

// 无法解析的时间戳在任何配置下都不应被当成过期，否则会误伤数据。
func TestUnparsableTimestampNeverExpires(t *testing.T) {
	t.Setenv("REDEEM_ACCESS_TTL_MS", "60000")
	cfg := config.Load()
	st := openTemp(t, cfg)

	for _, value := range []string{"", "not-a-date"} {
		if st.AccessExpired(value) {
			t.Fatalf("%q 不应判定为过期", value)
		}
		if got := st.AccessExpiresAt(value); got != nil {
			t.Fatalf("%q 的 access_expires_at 应为 nil，实际 %v", value, *got)
		}
	}
}
