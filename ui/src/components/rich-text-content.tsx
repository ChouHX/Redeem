import { useEffect, useMemo } from "react"
import { EditorContent, useEditor } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import Link from "@tiptap/extension-link"
import Placeholder from "@tiptap/extension-placeholder"
import {
  BoldIcon,
  Heading2Icon,
  ItalicIcon,
  LinkIcon,
  ListIcon,
  ListOrderedIcon,
  PilcrowIcon,
  QuoteIcon,
  RemoveFormattingIcon,
  RotateCcwIcon,
  RotateCwIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

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

function EditorToolbarButton({
  onClick,
  children,
  active = false,
  disabled = false,
}: {
  onClick: () => void
  children: React.ReactNode
  active?: boolean
  disabled?: boolean
}) {
  return (
    <Button
      type="button"
      variant={active ? "secondary" : "outline"}
      size="sm"
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </Button>
  )
}

export function RichTextEditor({
  value,
  onChange,
  className,
}: {
  value: string
  onChange: (value: string) => void
  className?: string
}) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: {
          levels: [2],
        },
      }),
      Link.configure({
        autolink: true,
        openOnClick: false,
      }),
      Placeholder.configure({
        placeholder: "在这里编辑 FAQ 内容...",
      }),
    ],
    content: value,
    immediatelyRender: false,
    onUpdate: ({ editor }) => {
      onChange(sanitizeRichTextHtml(editor.getHTML()))
    },
  })

  useEffect(() => {
    if (!editor) {
      return
    }

    const currentHtml = sanitizeRichTextHtml(editor.getHTML())
    const nextHtml = sanitizeRichTextHtml(value)
    if (currentHtml !== nextHtml) {
      editor.commands.setContent(nextHtml, { emitUpdate: false })
    }
  }, [editor, value])

  function applyLink() {
    if (!editor) {
      return
    }

    const currentHref = editor.getAttributes("link").href || "https://"
    const url = window.prompt("请输入链接地址", currentHref)
    if (url === null) {
      return
    }

    if (!url.trim()) {
      editor.chain().focus().unsetLink().run()
      return
    }

    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run()
  }

  return (
    <div className={cn("flex flex-col border border-border/70", className)}>
      <div className="tiptap-toolbar sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-border/70 bg-background/92 px-3 py-3 backdrop-blur-sm">
        <EditorToolbarButton
          onClick={() => editor?.chain().focus().undo().run()}
          disabled={!editor?.can().undo()}
        >
          <RotateCcwIcon data-icon="inline-start" />
          撤销
        </EditorToolbarButton>
        <EditorToolbarButton
          onClick={() => editor?.chain().focus().redo().run()}
          disabled={!editor?.can().redo()}
        >
          <RotateCwIcon data-icon="inline-start" />
          重做
        </EditorToolbarButton>

        <Separator orientation="vertical" className="h-6" />

        <EditorToolbarButton
          onClick={() => editor?.chain().focus().setParagraph().run()}
          active={Boolean(editor?.isActive("paragraph"))}
        >
          <PilcrowIcon data-icon="inline-start" />
          正文
        </EditorToolbarButton>
        <EditorToolbarButton
          onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
          active={Boolean(editor?.isActive("heading", { level: 2 }))}
        >
          <Heading2Icon data-icon="inline-start" />
          标题
        </EditorToolbarButton>

        <Separator orientation="vertical" className="h-6" />

        <EditorToolbarButton
          onClick={() => editor?.chain().focus().toggleBold().run()}
          active={Boolean(editor?.isActive("bold"))}
        >
          <BoldIcon data-icon="inline-start" />
          加粗
        </EditorToolbarButton>
        <EditorToolbarButton
          onClick={() => editor?.chain().focus().toggleItalic().run()}
          active={Boolean(editor?.isActive("italic"))}
        >
          <ItalicIcon data-icon="inline-start" />
          斜体
        </EditorToolbarButton>

        <Separator orientation="vertical" className="h-6" />

        <EditorToolbarButton
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
          active={Boolean(editor?.isActive("bulletList"))}
        >
          <ListIcon data-icon="inline-start" />
          无序列表
        </EditorToolbarButton>
        <EditorToolbarButton
          onClick={() => editor?.chain().focus().toggleOrderedList().run()}
          active={Boolean(editor?.isActive("orderedList"))}
        >
          <ListOrderedIcon data-icon="inline-start" />
          有序列表
        </EditorToolbarButton>
        <EditorToolbarButton
          onClick={() => editor?.chain().focus().toggleBlockquote().run()}
          active={Boolean(editor?.isActive("blockquote"))}
        >
          <QuoteIcon data-icon="inline-start" />
          引用
        </EditorToolbarButton>

        <Separator orientation="vertical" className="h-6" />

        <EditorToolbarButton
          onClick={applyLink}
          active={Boolean(editor?.isActive("link"))}
        >
          <LinkIcon data-icon="inline-start" />
          链接
        </EditorToolbarButton>
        <EditorToolbarButton
          onClick={() => editor?.chain().focus().clearNodes().unsetAllMarks().run()}
        >
          <RemoveFormattingIcon data-icon="inline-start" />
          清除格式
        </EditorToolbarButton>
      </div>

      <EditorContent
        editor={editor}
        className="rich-text-content tiptap-editor min-h-96 overflow-y-auto bg-card px-4 py-4"
      />

      <div className="flex items-center justify-between border-t border-border/70 bg-background/70 px-3 py-2 text-xs text-muted-foreground">
        <span>支持标题、列表、引用、链接和基础强调格式。</span>
        <span>{editor?.getText().trim().length || 0} 字</span>
      </div>
    </div>
  )
}
