import { defineRegistry } from '@json-render/react'
import { AgentActionButton, AgentCardPicker, AgentChoiceList, AgentSelectableTable } from '#/components/chat/AgentInteraction'
import { choiceFromRow } from '#/components/chat/interaction-message'
import { AnimatedBarChart, AnimatedDonutChart, normalizeChartData } from '#/components/ui/charts'
import { AnimatedAmount, Reveal } from '#/components/ui/motion'
import { catalog } from './catalog'
import { Card } from '#/components/ui/card'
import { AgentCardDisplay } from '#/components/chat/AgentCardDisplay'
import { useContext } from 'react'
import { AgentInteractionContext } from '#/components/chat/AgentInteraction'
import { displayPurpose } from '#/components/chat/display-purpose'

function useSelecting() { return displayPurpose(useContext(AgentInteractionContext).snapshot) === 'selection' }

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
    Table: ({ props }) => { const selecting = useSelecting(); return <AgentSelectableTable rows={asRows(props.rows)} columns={props.columns} selectable={selecting && props.selectable === true} /> },
    CardDisplay: ({ props }) => <AgentCardDisplay title={props.title} cardIds={props.cardIds} choices={asRows(props.data).flatMap(row => { const choice = choiceFromRow(row, 'card'); return choice ? [choice] : [] })} />,
    ChoiceList: ({ props }) => { const selecting = useSelecting(); const rows = asRows(props.data); return selecting ? <AgentChoiceList title={props.title} choices={rows.flatMap(row => { const choice = choiceFromRow(row, props.kind ?? undefined); return choice ? [choice] : [] })} /> : <AgentSelectableTable title={props.title} selectable={false} rows={rows} columns={[{key:'name',label:'名称'},{key:'remark',label:'备注'},{key:'status',label:'状态'}]} /> },
    CardPicker: ({ props }) => { const selecting = useSelecting(); const choices = asRows(props.data).flatMap(row => { const choice = choiceFromRow(row, 'card'); return choice ? [choice] : [] }); return selecting ? <AgentCardPicker title={props.title} role={props.role} choices={choices} /> : <AgentCardDisplay title={props.title} choices={choices} /> },
    Note: ({ props }) => <p className="bank-gen-note">{props.text}</p>,
    FollowUp: ({ props }) => { const selecting = useSelecting(); return selecting ? <AgentActionButton label={props.label} prompt={props.prompt} className="bank-follow-up bank-lift" /> : null },
    Confirm: ({ props }) => { const selecting = useSelecting(); return selecting ? <AgentActionButton label="确认" prompt={props.prompt} /> : null },
  },
})
