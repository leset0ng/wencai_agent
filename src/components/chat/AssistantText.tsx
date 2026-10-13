import { Table } from '#/components/ui/table'
import { createContext, useContext } from 'react'
import { Streamdown } from 'streamdown'
import type { Components, ExtraProps } from 'streamdown'
import type { ComponentProps } from 'react'
import type { WencaiUIMessage } from '#/server/agent/messages'
import type { ToolPresentation } from './presentation'

export interface PresentedTable {
  headers: string[]
  rows: string[][]
}
type Node = { tagName?: string; value?: string; children?: Node[] }
const TableContext = createContext<{ tables: PresentedTable[]; processing: boolean }>({ tables: [], processing: false })
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? value as Record<string, unknown> : {}

/** 只比较实际挂载的生成式表格；隐藏/失败视图及其他轮次不能吞掉文字结果。 */
export function presentedTables(parts: WencaiUIMessage['parts'], modes: ToolPresentation[]): PresentedTable[] {
  const tables: PresentedTable[] = []
  parts.forEach((part, index) => {
    if (part.type !== 'tool-show_view' || modes[index] !== 'result' || !('output' in part)) return
    const out = object(part.output)
    if (out.status !== 'view') return
    const spec = object(out.spec)
    const elements = object(spec.elements)
    const visited = new Set<string>()
    const visit = (id: string) => {
      if (visited.has(id)) return
      visited.add(id)
      const element = object(elements[id])
      const props = object(element.props)
      if (element.type === 'Table' && Array.isArray(props.columns)) {
        const columns = props.columns.map(object)
        const path = object(props.rows).$state
        let rows: unknown = spec.state
        if (typeof path !== 'string') return
        for (const key of path.split('/').slice(1)) rows = object(rows)[key.replace(/~1/g, '/').replace(/~0/g, '~')]
        if (Array.isArray(rows)) tables.push({
          headers: columns.map((column) => String(column.label ?? '')),
          rows: rows.map((row) => columns.map((column) => String(object(row)[String(column.key)] ?? ''))),
        })
      }
      if (Array.isArray(element.children)) element.children.forEach(visit)
    }
    if (typeof spec.root === 'string') visit(spec.root)
  })
  return tables
}

const textContent = (node: Node): string => node.value ?? node.children?.map(textContent).join('') ?? ''
function markdownTable(node: Node): PresentedTable {
  const headers: string[] = []
  const rows: string[][] = []
  const visit = (child: Node) => {
    if (child.tagName === 'tr') {
      const cells = child.children?.filter((cell) => ['td', 'th'].includes(cell.tagName ?? '')) ?? []
      if (cells.some((cell) => cell.tagName === 'th')) headers.push(...cells.map(textContent))
      else rows.push(cells.map(textContent))
    } else child.children?.forEach(visit)
  }
  visit(node)
  return { headers, rows }
}

function header(value: string) {
  const key = value.replace(/\s|[（(].*?[）)]/g, '')
  const groups = [['日期', '交易日期', '时间', '交易时间'], ['对方', '商户', '交易对方', '交易对象', '商户/对方', '商户／对方'],
    ['分类', '类别', '消费类别'], ['金额', '支出', '支出金额', '消费金额']]
  return groups.find((group) => group.includes(key))?.[0] ?? key
}
function cell(value: string, label: string) {
  const compact = value.trim().replace(/\s/g, '')
  if (!/金额|余额|支出|收入|费用|价格|总额|应还|合计/.test(label)) return compact
  const money = compact.replace(/^[¥￥]/, '').replace(/元$/, '').replace(/,/g, '').replace(/−/g, '-')
  return /^[+-]?\d+(\.\d+)?$/.test(money) && Math.abs(Number(money)) <= Number.MAX_SAFE_INTEGER / 100
    ? String(Number(money)) : compact
}
const sameCell = (a: string, b: string, label: string) => cell(a, label) === cell(b, label) ||
  (/^\d{4}-\d{2}-\d{2}$/.test(a) && /^\d{2}-\d{2}$/.test(b) && a.slice(5) === b) ||
  (/^\d{4}-\d{2}-\d{2}$/.test(b) && /^\d{2}-\d{2}$/.test(a) && b.slice(5) === a)

export function duplicatesTable(candidate: PresentedTable, shown: PresentedTable): boolean {
  if (!candidate.rows.length || candidate.rows.length !== shown.rows.length || candidate.headers.length !== shown.headers.length) return false
  const keys = shown.headers.map(header)
  const order = candidate.headers.map((label) => keys.indexOf(header(label)))
  if (order.some((index) => index < 0) || new Set(order).size !== order.length) return false
  // 多重集比较保留重复行的次数，容许相同结果在 Markdown 中换了排序或列顺序。
  const remaining = [...shown.rows]
  for (const row of candidate.rows) {
    const match = remaining.findIndex((other) => row.length === order.length && row.every((value, i) => sameCell(value, other[order[i]] ?? '', candidate.headers[i])))
    if (match < 0) return false
    remaining.splice(match, 1)
  }
  return true
}

function MarkdownTable({ node, children, ...props }: ComponentProps<'table'> & ExtraProps) {
  const { tables, processing } = useContext(TableContext)
  if (processing || (node && tables.some((shown) => duplicatesTable(markdownTable(node), shown)))) return null
  return <div className="bank-gen-table bank-chat-table"><Table {...props}>{children}</Table></div>
}
const COMPONENTS: Components = { table: MarkdownTable }

export default function AssistantText({ text, tables = [], processing = false }: {
  text: string; tables?: PresentedTable[]; processing?: boolean
}) {
  return (
    <TableContext.Provider value={{ tables, processing }}>
      <div className="bank-assistant-text">
        <Streamdown components={COMPONENTS} controls={{ table: false }} isAnimating={processing}>{text}</Streamdown>
      </div>
    </TableContext.Provider>
  )
}
