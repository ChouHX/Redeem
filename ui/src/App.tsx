import { lazy, Suspense } from "react"

const AdminConsole = lazy(() =>
  import("@/components/admin-console").then((m) => ({ default: m.AdminConsole }))
)
const RedeemConsole = lazy(() =>
  import("@/components/redeem-console").then((m) => ({ default: m.RedeemConsole }))
)
const MailConsole = lazy(() =>
  import("@/components/mail-console").then((m) => ({ default: m.MailConsole }))
)

function PageFallback() {
  return (
    <div className="flex min-h-svh items-center justify-center">
      <div className="text-sm text-muted-foreground">加载中...</div>
    </div>
  )
}

export function App() {
  const pathname = window.location.pathname

  if (pathname === "/" || pathname.startsWith("/redeem")) {
    return (
      <Suspense fallback={<PageFallback />}>
        <RedeemConsole />
      </Suspense>
    )
  }

  if (pathname.startsWith("/mail")) {
    return (
      <Suspense fallback={<PageFallback />}>
        <MailConsole />
      </Suspense>
    )
  }

  return (
    <Suspense fallback={<PageFallback />}>
      <AdminConsole />
    </Suspense>
  )
}

export default App
