import { useMemo } from "react"

import { cn } from "@/lib/utils"

// 只读渲染路径：不依赖 @tiptap/*，避免公开页面（/redeem）把整个编辑器打进首屏。
// 编辑态请用 rich-text-content.tsx 里的 RichTextEditor。

export function sanitizeRichTextHtml(html: string) {
  const parser = new DOMParser()
  const doc = parser.parseFromString(String(html || ""), "text/html")

  doc
    .querySelectorAll("script, iframe, object, embed, link, meta, base, form")
    .forEach((node) => {
      node.remove()
    })

  doc.querySelectorAll("*").forEach((element) => {
    Array.from(element.attributes).forEach((attribute) => {
      const name = attribute.name.toLowerCase()
      const value = attribute.value || ""

      if (name.startsWith("on")) {
        element.removeAttribute(attribute.name)
        return
      }

      if (
        ["href", "src", "xlink:href", "action", "formaction"].includes(name) &&
        /^\s*javascript:/i.test(value)
      ) {
        element.removeAttribute(attribute.name)
      }
    })
  })

  return doc.body.innerHTML
}

export function RichTextContent({
  html,
  className,
}: {
  html: string
  className?: string
}) {
  const safeHtml = useMemo(() => sanitizeRichTextHtml(html), [html])

  return (
    <div
      className={cn("rich-text-content", className)}
      dangerouslySetInnerHTML={{ __html: safeHtml }}
    />
  )
}
