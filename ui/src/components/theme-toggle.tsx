import { MonitorCogIcon, MoonStarIcon, SunIcon } from "lucide-react"

import { useTheme } from "@/components/theme-provider"
import { Button } from "@/components/ui/button"

const THEME_ORDER = ["system", "light", "dark"] as const

function nextTheme(theme: (typeof THEME_ORDER)[number]) {
  const currentIndex = THEME_ORDER.indexOf(theme)
  return THEME_ORDER[(currentIndex + 1) % THEME_ORDER.length]
}

function themeLabel(theme: (typeof THEME_ORDER)[number]) {
  if (theme === "light") {
    return "浅色"
  }

  if (theme === "dark") {
    return "深色"
  }

  return "跟随系统"
}

function ThemeIcon({ theme }: { theme: (typeof THEME_ORDER)[number] }) {
  if (theme === "light") {
    return <SunIcon data-icon="inline-start" />
  }

  if (theme === "dark") {
    return <MoonStarIcon data-icon="inline-start" />
  }

  return <MonitorCogIcon data-icon="inline-start" />
}

export function ThemeToggle() {
  const { theme, setTheme } = useTheme()

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => setTheme(nextTheme(theme))}
      title={`当前主题：${themeLabel(theme)}`}
    >
      <ThemeIcon theme={theme} />
      {themeLabel(theme)}
    </Button>
  )
}
