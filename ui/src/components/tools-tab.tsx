import { useEffect, useMemo, useState } from "react"
import {
  CopyIcon,
  DownloadIcon,
  GripVerticalIcon,
  TicketIcon,
} from "lucide-react"

import {
  exchangeRedeemCode,
  queryRedeemOrder,
} from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field, FieldContent, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { createTextExportFilename, downloadTextFile } from "@/lib/utils"
import { copyTextToClipboard, formatErrorMessage, notify } from "@/lib/shared"

type ToolFieldConfig = {
  key: string
  label: string
  index: number
  enabled: boolean
}

const TOOL_DEFAULT_SOURCE_DELIMITER = "----"
const TOOL_DEFAULT_OUTPUT_DELIMITER = "----"

function splitToolLine(line: string, delimiter: string) {
  return line.split(delimiter).map((item) => item.trim())
}

interface ToolsTabProps {
  onQueryCodeChange?: (code: string) => void
}

export function ToolsTab({ onQueryCodeChange }: ToolsTabProps) {
  const [toolCode, setToolCode] = useState("")
  const [toolInput, setToolInput] = useState("")
  const [toolSourceDelimiter, setToolSourceDelimiter] = useState(
    TOOL_DEFAULT_SOURCE_DELIMITER
  )
  const [toolOutputDelimiter, setToolOutputDelimiter] = useState(
    TOOL_DEFAULT_OUTPUT_DELIMITER
  )
  const [toolFields, setToolFields] = useState<ToolFieldConfig[]>([])
  const [draggedToolFieldKey, setDraggedToolFieldKey] = useState<string | null>(null)
  const [toolCodeSubmitting, setToolCodeSubmitting] = useState(false)

  const normalizedToolInputLines = useMemo(
    () => toolInput.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    [toolInput]
  )
  const expectedToolSegmentCount = useMemo(
    () =>
      normalizedToolInputLines[0]
        ? splitToolLine(
            normalizedToolInputLines[0],
            toolSourceDelimiter || TOOL_DEFAULT_SOURCE_DELIMITER
          ).length
        : 0,
    [normalizedToolInputLines, toolSourceDelimiter]
  )
  const selectedToolFields = useMemo(
    () => toolFields.filter((field) => field.enabled),
    [toolFields]
  )
  const toolOutputText = useMemo(
    () =>
      normalizedToolInputLines
        .map((line) => {
          const parts = splitToolLine(
            line,
            toolSourceDelimiter || TOOL_DEFAULT_SOURCE_DELIMITER
          )
          return selectedToolFields
            .map((field) => parts[field.index] || "")
            .join(toolOutputDelimiter || TOOL_DEFAULT_OUTPUT_DELIMITER)
        })
        .join("\n"),
    [normalizedToolInputLines, toolSourceDelimiter, toolOutputDelimiter, selectedToolFields]
  )
  const invalidToolLineCount = useMemo(
    () =>
      normalizedToolInputLines.filter((line) => {
        const delimiter = toolSourceDelimiter || TOOL_DEFAULT_SOURCE_DELIMITER
        return line.split(delimiter).length < Math.max(expectedToolSegmentCount, 1)
      }).length,
    [normalizedToolInputLines, toolSourceDelimiter, expectedToolSegmentCount]
  )

  useEffect(() => {
    if (!expectedToolSegmentCount) {
      setToolFields([])
      return
    }

    setToolFields((current) => {
      const currentMap = new Map(current.map((field) => [field.index, field]))
      const keptIndexes = current
        .map((field) => field.index)
        .filter((index) => index < expectedToolSegmentCount)
      const missingIndexes = Array.from(
        { length: expectedToolSegmentCount },
        (_, index) => index
      ).filter((index) => !keptIndexes.includes(index))

      return [...keptIndexes, ...missingIndexes].map((index) => {
        const existing = currentMap.get(index)
        return {
          key: `segment_${index}`,
          index,
          label: `第 ${index + 1} 段`,
          enabled: existing ? existing.enabled : index < 2,
        }
      })
    })
  }, [expectedToolSegmentCount])

  function moveToolFieldToTarget(sourceKey: string, targetKey: string) {
    if (sourceKey === targetKey) {
      return
    }

    setToolFields((current) => {
      const sourceIndex = current.findIndex((field) => field.key === sourceKey)
      const targetIndex = current.findIndex((field) => field.key === targetKey)
      if (sourceIndex < 0 || targetIndex < 0) {
        return current
      }

      const nextFields = [...current]
      const [sourceField] = nextFields.splice(sourceIndex, 1)
      nextFields.splice(targetIndex, 0, sourceField)
      return nextFields
    })
  }

  function toggleToolField(key: string, enabled: boolean) {
    setToolFields((current) =>
      current.map((field) =>
        field.key === key ? { ...field, enabled } : field
      )
    )
  }

  function applyToolPreset(mode: "first_two" | "all") {
    setToolFields((current) =>
      current.map((field, index) => ({
        ...field,
        enabled: mode === "all" ? true : index < 2,
      }))
    )
  }

  function resetTool() {
    setToolCode("")
    setToolInput("")
    setToolSourceDelimiter(TOOL_DEFAULT_SOURCE_DELIMITER)
    setToolOutputDelimiter(TOOL_DEFAULT_OUTPUT_DELIMITER)
    setToolFields([])
    setDraggedToolFieldKey(null)
  }

  async function importToolSourceByCode() {
    const nextCode = toolCode.trim()
    if (!nextCode) {
      notify("请输入兑换码", "导入原始数据前需要先输入兑换码。", "destructive")
      return
    }

    setToolCodeSubmitting(true)

    try {
      try {
        const queried = await queryRedeemOrder(nextCode)
        const importedText = queried.items.map((item) => item.formatted_line).join("\n")
        setToolInput(importedText)
        notify("导入成功", `已从已兑换订单导入 ${queried.item_count} 条原始数据。`)
        return
      } catch (queryError) {
        const queryMessage = formatErrorMessage(queryError)
        const shouldExchange =
          queryMessage.includes("尚未兑换") ||
          queryMessage.includes("暂无订单可查询")

        if (!shouldExchange) {
          notify("导入失败", queryMessage, "destructive")
          return
        }
      }

      const exchanged = await exchangeRedeemCode(nextCode)
      const importedText = exchanged.data.items
        .map((item) => item.formatted_line)
        .join("\n")
      setToolInput(importedText)
      onQueryCodeChange?.(exchanged.data.code)
      notify(
        "兑换并导入成功",
        `已自动兑换并导入 ${exchanged.data.redeemed_count} 条原始数据。`
      )
    } catch (exchangeError) {
      notify("导入失败", formatErrorMessage(exchangeError), "destructive")
    } finally {
      setToolCodeSubmitting(false)
    }
  }

  function handleToolDownload() {
    if (!toolOutputText.trim()) {
      notify("没有可导出内容", "请先输入原始数据并选择要输出的字段。", "destructive")
      return
    }

    downloadTextFile(
      toolOutputText,
      createTextExportFilename("redeem_extract", "fields")
    )
    notify("导出成功", `已导出 ${normalizedToolInputLines.length} 行提取结果。`)
  }

  return (
    <Card className="border border-border/70 bg-card/97">
      <CardHeader className="border-b border-border/70">
        <CardTitle className="text-xl md:text-2xl">字段提取工具</CardTitle>
        <CardDescription>
          纯前端处理，不会把内容提交到服务器。可手动粘贴原始数据，或直接通过兑换码导入；系统会按第一行自动识别段数，再由你自由选择和排序输出字段。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <FieldGroup>
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto]">
            <Field>
              <FieldLabel htmlFor="tool-code">通过兑换码导入</FieldLabel>
              <FieldContent>
                <Input
                  id="tool-code"
                  value={toolCode}
                  onChange={(event) => setToolCode(event.target.value)}
                  placeholder="输入兑换码后自动导入原始数据"
                  autoComplete="off"
                />
              </FieldContent>
            </Field>
            <div className="flex items-end">
              <Button
                type="button"
                variant="outline"
                onClick={() => void importToolSourceByCode()}
                disabled={toolCodeSubmitting}
              >
                <TicketIcon data-icon="inline-start" />
                {toolCodeSubmitting ? "导入中..." : "导入数据"}
              </Button>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="tool-source-delimiter">
                输入分隔符
              </FieldLabel>
              <FieldContent>
                <Input
                  id="tool-source-delimiter"
                  value={toolSourceDelimiter}
                  onChange={(event) =>
                    setToolSourceDelimiter(event.target.value)
                  }
                />
              </FieldContent>
            </Field>
            <Field>
              <FieldLabel htmlFor="tool-output-delimiter">
                输出分隔符
              </FieldLabel>
              <FieldContent>
                <Input
                  id="tool-output-delimiter"
                  value={toolOutputDelimiter}
                  onChange={(event) =>
                    setToolOutputDelimiter(event.target.value)
                  }
                />
              </FieldContent>
            </Field>
          </div>
        </FieldGroup>

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => applyToolPreset("first_two")}
          >
            前两段
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => applyToolPreset("all")}
          >
            全部段
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={resetTool}
          >
            清空
          </Button>
        </div>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="tool-input">原始数据</FieldLabel>
              <FieldContent>
                <Textarea
                  id="tool-input"
                  value={toolInput}
                  onChange={(event) => setToolInput(event.target.value)}
                  placeholder="每行一条，例如&#10;account@example.com----password----client_id_value----refresh_token_value"
                  wrap="off"
                  spellCheck={false}
                  className="h-80 resize-none overflow-x-auto overflow-y-auto font-mono text-xs leading-6"
                />
              </FieldContent>
            </Field>
          </FieldGroup>

          <div className="flex flex-col gap-4">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="tool-output">输出结果</FieldLabel>
                <FieldContent>
                  <Textarea
                    id="tool-output"
                    value={toolOutputText}
                    readOnly
                    wrap="off"
                    spellCheck={false}
                    className="h-80 resize-none overflow-x-auto overflow-y-auto font-mono text-xs leading-6"
                  />
                </FieldContent>
              </Field>
            </FieldGroup>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">
                  输入 {normalizedToolInputLines.length} 行
                </Badge>
                <Badge variant="outline">
                  识别 {expectedToolSegmentCount} 段
                </Badge>
                <Badge variant="outline">
                  输出 {selectedToolFields.length} 段
                </Badge>
                {invalidToolLineCount ? (
                  <Badge variant="secondary">
                    疑似异常 {invalidToolLineCount} 行
                  </Badge>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    void copyTextToClipboard(toolOutputText, "提取结果")
                  }
                  disabled={!toolOutputText.trim()}
                >
                  <CopyIcon data-icon="inline-start" />
                  复制结果
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleToolDownload}
                  disabled={!toolOutputText.trim()}
                >
                  <DownloadIcon data-icon="inline-start" />
                  导出 TXT
                </Button>
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3 border border-border/70 bg-background/70 px-4 py-4">
          <p className="text-xs text-muted-foreground">输出字段顺序</p>
          <div className="flex flex-wrap gap-2">
            {toolFields.length ? (
              toolFields.map((field) => (
                <Badge
                  key={field.key}
                  asChild
                  variant={field.enabled ? "secondary" : "outline"}
                  className="px-0 py-0"
                >
                  <button
                    type="button"
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = "move"
                      setDraggedToolFieldKey(field.key)
                    }}
                    onDragEnd={() => setDraggedToolFieldKey(null)}
                    onDragOver={(event) => event.preventDefault()}
                    onDragEnter={() => {
                      if (draggedToolFieldKey && draggedToolFieldKey !== field.key) {
                        moveToolFieldToTarget(draggedToolFieldKey, field.key)
                      }
                    }}
                    onDrop={() => {
                      if (draggedToolFieldKey) {
                        moveToolFieldToTarget(draggedToolFieldKey, field.key)
                      }
                      setDraggedToolFieldKey(null)
                    }}
                    onClick={() => toggleToolField(field.key, !field.enabled)}
                    className={
                      draggedToolFieldKey === field.key
                        ? "inline-flex items-center gap-2 px-3 py-1.5 text-xs opacity-60 ring-1 ring-ring/40 transition-all duration-150 cursor-grabbing"
                        : "inline-flex items-center gap-2 px-3 py-1.5 text-xs transition-all duration-150 cursor-grab hover:bg-muted/50"
                    }
                  >
                    <GripVerticalIcon data-icon="inline-start" />
                    <span>{field.label}</span>
                  </button>
                </Badge>
              ))
            ) : (
              <div className="text-sm text-muted-foreground">
                先输入一行数据，系统会根据第一行自动识别字段段数。
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
