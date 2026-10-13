import { JSONUIProvider, Renderer } from '@json-render/react'
import { registry } from '#/genui/registry'
import { isRetryableConfirmError, useCancelAction, useConfirmAction } from '#/lib/queries'
import type { StepUpPayload } from '#/lib/queries'
import type { ToolOutcome } from '#/server/tools/define'
import type { PlanState } from '#/server/executor/executor'
import ConfirmCard from './ConfirmCard'
import { BankCard } from '#/components/ui/BankCard'
import { Reveal } from '#/components/ui/motion'
import { normalizeChartData } from '#/components/ui/charts'
import { FinancialReport } from '#/components/banking/FinancialReport'
import { useQuery } from '@tanstack/react-query'
import { CardPasswordAction } from '#/components/ui/CardPasswordAction'
import { AgentCardPicker, AgentChoiceList, AgentSelectableTable, AgentInteractionContext, AgentChoiceContext } from './AgentInteraction'
import { selectionView } from './interaction-layout'
import { choiceFromRow, operationMessage, type ChoiceKind } from './interaction-message'
import { useContext } from 'react'

export interface ToolUIPart {
  type: `tool-${string}`
  toolCallId: string
  state: 'input-streaming' | 'input-available' | 'output-available' | 'output-error'
  output?: unknown
  errorText?: string
}

const TOOL_LABEL: Record<string, string> = {
  get_accounts: '查询账户',
  list_transactions: '查询交易',
  find_payee: '查找收款人',
  list_cards: '查询卡片',
  show_bank_card: '查看银行卡',
  card_password_settings: '银行卡密码设置',
  list_subscriptions: '识别订阅',
  list_products: '查询理财产品',
  analyze_spending: '账单分析',
  get_spending_report: '消费报表',
  transfer: '转账',
  search_bank_accounts: '查找银行收款账户',
  list_payees: '我的收款人',
  add_payee: '添加收款人',
  transfer_between_accounts: '本人账户互转',
  resolve_my_cards: '查找我的银行卡',
  transfer_between_cards: '银行卡互转',
  set_card_remark: '修改卡片备注',
  repay_credit_card: '信用卡还款',
  apply_card: '申请银行卡',
  adjust_credit_limit: '调整信用额度',
  detect_subscriptions: '识别周期扣款',
  save_detected_subscription: '管理识别的订阅',
  list_notifications: '查看提醒',
  list_split_requests: '查看待付款AA',
  pay_split_request: '支付AA',
  create_birthday_plan: '创建生日计划',
  execute_birthday_order: '预订生日礼品',
  list_birthday_plans: '查看生日计划',
  lock_card: '临时锁卡',
  unlock_card: '解锁卡片',
  report_card_lost: '挂失',
  adjust_card_limit: '调整限额',
  cancel_subscription: '取消订阅',
  request_password_change: '修改交易密码',
  create_standing_mandate: '设置定期转账授权',
  list_standing_mandates: '查看定期转账授权',
  revoke_standing_mandate: '撤销定期转账授权',
  plan_task: '任务规划',
  show_view: '生成视图',
}

/**
 * 工具结果渲染：按 status 分派到固定组件。
 * 安全关键内容（确认单、余额、回执）全部来自工具输出的结构化数据，不经模型转述。
 */
export default function ToolPart({
  part,
  summarized = false,
}: {
  part: ToolUIPart
  onFollowUp?: (text: string) => void
  summarized?: boolean
}) {
  const choices = useContext(AgentChoiceContext)
  const tool = part.type.slice('tool-'.length)
  const label = TOOL_LABEL[tool] ?? tool

  if (part.state === 'input-streaming' || part.state === 'input-available') {
    return <Chip>⏳ {label}…</Chip>
  }
  if (part.state === 'output-error') {
    return (
      <Chip>
        ⚠️ {label}失败：{part.errorText}
      </Chip>
    )
  }

  if (tool === 'show_view') {
    const out = part.output as
      | { status: 'view'; spec: never }
      | { status: 'invalid_view'; errors: string[] }
    if (out.status !== 'view') return <Chip>⚠️ 视图未通过校验</Chip>
    if (summarized) return <Chip>✓ 结果已整理</Chip>
    const spec = selectionView(out.spec, choices?.hasChoices || choices?.securityConfirmation, choices?.securityConfirmation)
    if (!spec) return null
    return (
        <JSONUIProvider
          registry={registry}
          initialState={spec.state}
        >
          <Renderer spec={spec as never} registry={registry} />
        </JSONUIProvider>
    )
  }

  if (tool === 'plan_task') {
    const out = part.output as
      | { status: 'plan'; state: PlanState }
      | { status: 'invalid_plan'; errors: string[] }
    if (out.status !== 'plan') return <Chip>⚠️ 计划未通过校验：{out.errors.join('；')}</Chip>
    return <PlanView state={out.state} />
  }

  if (summarized && (part.output as ToolOutcome)?.status === 'done') return <Chip>✓ {label}</Chip>
  return <Outcome label={label} tool={tool} outcome={part.output as ToolOutcome} />
}

/**
 * 一条待确认操作。确认/取消走 Query mutation：自动管理提交态与错误态，
 * 服务端仍然做完整性、归属、一次性消费与强验证校验。
 */
function PendingControl({
  outcome,
}: {
  outcome: Extract<ToolOutcome, { status: 'needs_confirmation' }>
}) {
  const confirm = useConfirmAction(outcome.actionId)
  const cancel = useCancelAction(outcome.actionId)
  const interaction = useContext(AgentInteractionContext)
  const pending = useQuery({ queryKey: ['confirm', outcome.actionId], queryFn: async () => {
    const response = await fetch(`/api/confirm?actionId=${encodeURIComponent(outcome.actionId)}`)
    if (!response.ok) throw new Error('无法读取确认状态')
    return response.json() as Promise<{ status: string }>
  }, enabled: interaction.enabled, staleTime: 30_000, retry: false })

  // 强验证输错（step_up_failed）允许重试；not_found / tampered / expired 等是终态，
  // 该操作已无法执行；Agent 卡片保留“重新办理”入口，重新生成受保护的确认单。
  const failedForGood = confirm.error !== null && !isRetryableConfirmError(confirm.error)
  const succeeded = confirm.isSuccess || pending.data?.status === 'completed'
  const cancelled = cancel.isSuccess || pending.data?.status === 'cancelled'
  const expired = pending.data?.status === 'expired'

  return (
    <ConfirmCard
      {...outcome}
      submitting={confirm.isPending || cancel.isPending || pending.data?.status === 'processing'}
      error={failedForGood ? undefined : (confirm.error ?? cancel.error)?.message}
      done={
        succeeded
          ? '操作已完成'
          : cancelled
            ? '已取消操作'
            : expired
              ? '确认已超时，可重新办理'
            : pending.data?.status === 'failed'
              ? '执行未完成，可重新办理'
            : failedForGood
              ? confirm.error?.message
              : undefined
      }
      doneState={succeeded ? 'success' : cancelled ? 'cancelled' : 'failed'}
      onAgentAction={interaction.enabled ? (action) => {
        if (interaction.busy) return false
        // A bank confirmation is immutable: a draft on another picker cannot change its payload.
        return interaction.send(operationMessage(outcome.summary, interaction.snapshot, action), action === 'verify' ? { verificationActionId: outcome.actionId } : action === 'cancel' ? { cancelActionId: outcome.actionId } : action === 'receipt' ? { confirmedActionId: outcome.actionId } : undefined) !== false
      } : undefined}
      agentBusy={interaction.enabled && interaction.busy}
      onConfirm={async (stepUp?: StepUpPayload) => {
        await confirm.mutateAsync(stepUp)
      }}
      onCancel={() => cancel.mutate()}
    />
  )
}

function Outcome({ label, tool, outcome }: { label: string; tool: string; outcome: ToolOutcome }) {
  switch (outcome.status) {
    case 'needs_confirmation':
      return (
        <Reveal>
          <PendingControl outcome={outcome} />
        </Reveal>
      )
    case 'needs_handoff':
      return (
        <div className="rounded-2xl border border-red-300 p-4 text-sm">
          <p className="m-0 font-semibold">{outcome.summary.title}</p>
          <p className="m-0 mt-1 text-[var(--sea-ink-soft)]">该操作需要在 App 内完成强验证：</p>
          <a
            href={outcome.url}
            className="mt-2 inline-block font-semibold text-[var(--lagoon-deep)]"
          >
            前往验证 →
          </a>
        </div>
      )
    case 'denied':
      return (
        <Chip>
          🚫 {label}被风控拒绝：{outcome.reasons.join('；')}
        </Chip>
      )
    case 'error':
      return (
        <Chip>
          ⚠️ {label}失败：{outcome.message}
        </Chip>
      )
    case 'done':
      return <CompletedResult label={label} tool={tool} data={outcome.data} />
  }
}

function choicesOf(data: unknown, kind?: ChoiceKind) {
  return (Array.isArray(data) ? data : []).flatMap((row) => {
    if (!row || typeof row !== 'object') return []
    const choice = choiceFromRow(row, kind)
    return choice ? [choice] : []
  })
}
function Accounts({ data }: { data: Record<string, unknown>[] }) {
  const cards = choicesOf(data.filter((row) => row.cardId && row.last4), 'card')
  const accounts = choicesOf(data.filter((row) => !row.cardId || !row.last4), 'account')
  return <>{!!cards.length && <AgentCardPicker choices={cards} />}{!!accounts.length && <AgentChoiceList choices={accounts} title="选择资金账户" />}{!data.length && <Chip>暂无账户</Chip>}</>
}

function CompletedResult({ label, tool, data }: { label: string; tool: string; data: unknown }) {
  if (tool === 'card_password_settings' && data && typeof data === 'object') return <CardPasswordAction {...data as { cardId: string; last4: string }} />
  if (tool === 'show_bank_card' && data && typeof data === 'object') {
    const card = data as { cardId: string; name: string; last4: string; kind: string; status: string }
    return <BankCard {...card} />
  }
  if (tool === 'request_password_change' && data && typeof data === 'object') {
    const out = data as { status?: string; url?: string; message?: string; expiresAt?: number }
    if (out.status !== 'password_change_authorized' || !out.url) return <Chip>✓ {label}</Chip>
    return (
      <Reveal>
        <div className="rounded-2xl border border-blue-200 bg-blue-50/60 p-4 text-sm">
          <p className="m-0 font-semibold text-[var(--sea-ink)]">强验证已通过，请设置新密码</p>
          <p className="m-0 mt-1 text-xs text-[var(--sea-ink-soft)]">
            {out.message ?? '请在有效期内到安全设置页设置新密码。'}
          </p>
          <a href={out.url} className="mt-3 inline-block font-semibold text-[var(--lagoon-deep)]">
            前往安全设置设置新密码 →
          </a>
        </div>
      </Reveal>
    )
  }
  if (tool === 'get_accounts' && Array.isArray(data)) return <Accounts data={data} />
  if (tool === 'list_cards' && Array.isArray(data))
    return <AgentCardPicker choices={choicesOf(data, 'card')} />
  if (['list_payees', 'list_subscriptions'].includes(tool) && Array.isArray(data))
    return <AgentChoiceList choices={choicesOf(data, tool === 'list_payees' ? 'recipient' : 'subscription')} title={tool === 'list_payees' ? '选择收款人' : '选择订阅'} />
  if (['resolve_my_cards', 'resolve_card'].includes(tool) && data && typeof data === 'object') {
    const out = data as { candidates?: unknown[]; found?: boolean }
    if (Array.isArray(out.candidates)) return <AgentCardPicker choices={choicesOf(out.candidates, 'card')} />
  }
  if ((tool === 'list_products' && Array.isArray(data)) || (tool === 'get_recommendations' && data && typeof data === 'object')) {
    const rows = Array.isArray(data) ? data : (data as { products?: Record<string, unknown>[] }).products ?? []
    return <AgentSelectableTable title="理财可选方案" rows={rows} columns={[{ key: 'name', label: '产品' }, { key: 'riskRating', label: '风险' }, { key: 'expectedYieldPct', label: '预期年化/%' }, { key: 'minAmount', label: '起购/元' }, { key: 'termDays', label: '期限/天' }]} />
  }
  if (['find_payee', 'resolve_recipient', 'resolve_product', 'resolve_subscription', 'search_bank_accounts'].includes(tool) && data && typeof data === 'object') {
    const out = data as { candidates?: unknown[] }
    if (out.candidates?.length) {
      const kind: ChoiceKind = tool === 'resolve_product' ? 'product' : tool === 'resolve_subscription' ? 'subscription' : 'recipient'
      const choices = choicesOf(out.candidates, kind)
      if (choices.length) return <AgentChoiceList choices={choices} title={kind === 'product' ? '选择理财产品' : kind === 'subscription' ? '选择订阅' : '选择收款人'} />
    }
  }
  if (tool === 'get_spending_report' && data && typeof data === 'object') {
    const report = data as { period: string; expense: number; categories: Record<string, number> }
    if (
      Number.isFinite(report.expense) &&
      report.categories &&
      typeof report.categories === 'object'
    ) {
      const categories = Object.entries(report.categories).map(([label, value]) => ({
        label,
        value,
      }))
      return (
        <FinancialReport
          title={`${report.period} 支出分类`}
          total={report.expense}
          data={normalizeChartData(categories, 'label', 'value')}
        />
      )
    }
  }
  if (tool === 'analyze_spending' && data && typeof data === 'object') {
    const report = data as { days: number; result?: { totalSpent?: number; byCategory?: unknown } }
    if (
      typeof report.result?.totalSpent === 'number' &&
      Number.isFinite(report.result.totalSpent) &&
      Array.isArray(report.result.byCategory)
    ) {
      return (
        <FinancialReport
          title={`近 ${report.days} 天支出分类`}
          total={report.result.totalSpent}
          data={normalizeChartData(report.result.byCategory, 'category', 'total')}
        />
      )
    }
  }
  return <Chip>✓ {label}</Chip>
}

const NODE_ICON: Record<string, string> = {
  pending: '○',
  done: '✓',
  suspended: '⏸',
  failed: '✗',
  compensated: '↺',
  skipped: '–',
  handoff: '👤',
}

export function PlanView({ state }: { state: PlanState }) {
  const plans = useQuery({ queryKey: ['plans'], queryFn: async () => { const res = await fetch('/api/plans'); if (!res.ok) throw new Error('无法读取计划'); return res.json() as Promise<{ plans: { state: PlanState }[] }> } })
  const latest = plans.data?.plans.find((p) => p.state.id === state.id)?.state ?? state
  return (
    <div className="space-y-2 rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] p-4">
      <p className="m-0 font-semibold text-[var(--sea-ink)]">📋 {state.plan.goal}</p>
      <ol className="m-0 list-none space-y-1 p-0 text-sm">
        {state.plan.nodes.map((n) => (
          <li key={n.id}>
            {NODE_ICON[latest.nodes[n.id].status]} {n.note ?? n.tool ?? '转人工'}
          </li>
        ))}
      </ol>
        {Object.entries(latest.nodes).filter(([, node]) => node.status === 'suspended').map(([id, node]) => {
          const outcome = node.output as ToolOutcome | undefined
          const definition = latest.plan.nodes.find((item) => item.id === id)
          return outcome && <Outcome key={`${id}-${node.actionId}`} label={definition?.note ?? '核对操作'} tool={definition?.tool ?? ''} outcome={outcome} />
        })}
      <p className="text-xs demo-muted">可在生活页的任务中心暂停、恢复或进行人工处理。</p>
    </div>
  )
}

function Chip({ children }: { children: React.ReactNode }) {
  return <p className="m-0 text-xs text-[var(--sea-ink-soft)]">{children}</p>
}
