// Command server 是 Go 版后端入口。
// 环境变量与 Node 版共用一套（NODE_BACKEND_PORT / NODE_BACKEND_HOST），
// 灰度期可以两套同时跑，靠端口区分。
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"
	// 内嵌时区库：distroless/scratch 镜像里没有 /usr/share/zoneinfo，
	// 导出文件名用的 Asia/Shanghai 会拿不到。
	_ "time/tzdata"

	"github.com/redeem/backend/internal/config"
	"github.com/redeem/backend/internal/httpapi"
	"github.com/redeem/backend/internal/store"
)

// healthcheck 访问本机目录接口，返回进程退出码。
func healthcheck(cfg config.Config) int {
	client := &http.Client{Timeout: 5 * time.Second}
	url := "http://127.0.0.1:" + strconv.Itoa(cfg.Port) + "/api/redeem/catalog"
	response, err := client.Get(url)
	if err != nil {
		return 1
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

func main() {
	cfg := config.Load()

	// distroless 镜像里没有 curl，容器健康检查用二进制自己发请求。
	if len(os.Args) > 1 && os.Args[1] == "-healthcheck" {
		os.Exit(healthcheck(cfg))
	}

	database, err := store.Open(cfg)
	if err != nil {
		log.Fatalf("打开数据库失败: %v", err)
	}
	defer database.Close()

	// 老库首次启动时没有兑换类型，补一个默认类型，否则前端目录是空的。
	if _, err := database.EnsureDefaultRedeemType(); err != nil {
		log.Printf("初始化默认兑换类型失败: %v", err)
	}

	server := &http.Server{
		Addr:              cfg.Host + ":" + strconv.Itoa(cfg.Port),
		Handler:           httpapi.New(cfg, database).Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	go func() {
		log.Printf("server_started url=http://%s:%d db=%s", cfg.Host, cfg.Port, cfg.DBPath)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("服务启动失败: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop

	log.Println("server_stopping")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		log.Printf("优雅退出失败: %v", err)
	}
}
