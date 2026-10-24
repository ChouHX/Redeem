package httpapi

import (
	"log"
	"net/http"
	"time"
)

// slowRequestThreshold 只记录慢请求。
// Node 版没有逐请求日志，这里保留一个慢查询告警：
// 「查询半天」这类问题需要现场证据，但每请求打日志本身又拖慢吞吐。
const slowRequestThreshold = 300 * time.Millisecond

// withRecover 兜住 panic，避免单个请求打挂整个进程。
func withRecover(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		defer func() {
			if recovered := recover(); recovered != nil {
				log.Printf("panic recovered: %s %s: %v", request.Method, request.URL.Path, recovered)
				writeJSON(w, http.StatusInternalServerError, fail("服务内部错误", nil))
			}
		}()
		next.ServeHTTP(w, request)
	})
}

// withAccessLog 只对慢请求记一条，日志里带耗时便于定位。
func withAccessLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		started := time.Now()
		next.ServeHTTP(w, request)
		if elapsed := time.Since(started); elapsed >= slowRequestThreshold {
			log.Printf("slow_request %s %s %dms", request.Method, request.URL.Path, elapsed.Milliseconds())
		}
	})
}
