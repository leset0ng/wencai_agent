import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from '#/components/ui/table'
import { Button } from '#/components/ui/button'
import { defineRegistry } from '@json-render/react'
import { createContext, useContext } from 'react'
import { AnimatedBarChart, AnimatedDonutChart, normalizeChartData } from '#/components/ui/charts'
import { AnimatedAmount, Reveal } from '#/components/ui/motion'
import { catalog } from './catalog'
import { Card } from '#/components/ui/card'

/** FollowUp 点击后以用户身份发送消息。数值仍只能由已验证的 state 引用传入。 */
export const FollowUpContext = createContext<(prompt: string) => void>(() => {})
type Row = Record<string, unknown>
const asRows = (value: unknown): Row[] =>
  Array.isArray(value) ? value.filter((row) => row !== null && typeof row === 'object') : []
const num = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0)

/** 首页、固定工具回执与生成式视图使用同一套图表和入场组件。 */
export const { registry } = defineRegistry(catalog, {
  components: {
    Panel: ({ props, children }) => (
      <Reveal>
        <Card className="bank-gen-panel" initial={false} animate={{ opacity: 1, y: 0 }}>
          <h3>{props.title}</h3>
          {props.subtitle && <p>{props.subtitle}</p>}
          <div className="bank-gen-children">{children}</div>
        </Card>
      </Reveal>
    ),
    Metric: ({ props }) => (
      <div className="bank-gen-metric">
        <span>{props.label}</span>
        {props.unit === '元' ? (
          <AnimatedAmount value={num(props.value)} prefix="¥ " />
        ) : (
          <span>
            {num(props.value)}
            {props.unit ?? ''}
          </span>
        )}
      </div>
    ),
    BarChart: ({ props }) => (
      <AnimatedBarChart
        title={props.title}
        data={normalizeChartData(props.data, props.labelKey, props.valueKey)}
      />
    ),
    PieChart: ({ props }) => (
      <AnimatedDonutChart
        title={props.title}
        data={normalizeChartData(props.data, props.labelKey, props.valueKey)}
      />
    ),
    Table: ({ props }) => (
      <div className="bank-gen-table">
        <Table>
          <TableHeader>
            <TableRow>
              {props.columns.map((column) => (
                <TableHead key={column.key}>{column.label}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {asRows(props.rows).map((row, index) => (
              <TableRow key={index} animated delay={Math.min(index, 10) * .05}>
                {props.columns.map((column) => (
                  <TableCell key={column.key}>{String(row[column.key] ?? '')}</TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    ),
    Note: ({ props }) => <p className="bank-gen-note">{props.text}</p>,
    FollowUp: ({ props }) => <FollowUpButton label={props.label} prompt={props.prompt} />,
  },
})

function FollowUpButton({ label, prompt }: { label: string; prompt: string }) {
  const send = useContext(FollowUpContext)
  return (
    <Button onClick={() => send(prompt)} className="bank-follow-up bank-lift" type="button">
      {label}
    </Button>
  )
}
