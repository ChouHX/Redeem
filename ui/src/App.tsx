import { AdminConsole } from "@/components/admin-console"
import { MailConsole } from "@/components/mail-console"
import { RedeemConsole } from "@/components/redeem-console"

export function App() {
  const pathname = window.location.pathname

  if (pathname.startsWith("/mail")) {
    return <MailConsole />
  }

  if (pathname === "/" || pathname.startsWith("/redeem")) {
    return <RedeemConsole />
  }

  return <AdminConsole />
}

export default App
