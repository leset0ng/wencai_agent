/**
 * 决策链还原：把审计表里的扁平事件，按"一次用户请求"重新串成可读链路。
 *
 * 纯函数，无 I/O，可单测。调用方负责从数据库取行并按 seq 升序传入。
 *
 * 还原规则：
 * - `user_input` 是链的边界：它开启一条新链，下一条 `user_input` 之前的记录都属于它。
 * - 带 `actionId` 的后续事件（确认、执行、补偿）通过 actionId 回溯到创建它的那条链，
 *   这样即使确认发生在另一个会话（H5 / 飞书），也能接回原始请求。
 * - `policy_decision` 出现多次时以最后一次为准：确认时会按执行时事实重新判定。
 */

export interface TraceInput {
  seq: number
  at: string
  channel: string
  sessionId: string
  type: string
  payloadJson: string
  hash: string
}

export type StepTone = 'green' | 'yellow' | 'red' | 'danger' | 'neutral'

export interface TraceStep {
  seq: number
  at: string
  type: string
  label: string
  tone: StepTone
  detail: string
  hash: string
}

export type TraceOutcome =
  | 'blocked'
  | 'denied'
  | 'pending'
  | 'confirmed'
  | 'failed'
  | 'compensated'
  | 'ok'
  | 'open'

export interface TraceGuard {
  verdict: string
  score: number
  categories: string[]
  provider: string
}

export interface Trace {
  id: string
  sessionId: string
  channel: string
  startedAt: string
  endedAt: string
  /** 触发这条链的用户原话（截断展示） */
  request: string
  guard: TraceGuard | null
  tools: string[]
  level: 'green' | 'yellow' | 'red' | null
  allowed: boolean | null
  reasons: string[]
  facts: Record<string, unknown> | null
  outcome: TraceOutcome
  /** 数字核验提示数量 */
  verified: number
  /** 被隔离的外部文本数量 */
  redacted: number
  steps: TraceStep[]
}

const LABELS: Record<string, string> = {
  user_input: '用户消息',
  guard_verdict: '输入审核',
  plan_created: '创建计划',
  plan_control: '计划控制',
  tool_call: '工具调用',
  tool_result: '工具结果',
  policy_decision: '策略判定',
  pending_created: '生成确认单',
  confirm_attempt: '用户确认',
  action_executed: '执行完成',
  action_compensated: '补偿回滚',
  injection_redacted: '隔离可疑文本',
  output_verification: '回复数字核验',
  circuit_breaker: '熔断锁定',
  handoff: '转人工',
  admin_command: '后台人工操作',
  session_revoked: '踢出会话',
  channel_bound: '绑定渠道',
  channel_unbound: '解绑渠道',
  bind_rejected: '绑定被拒',
  tx_password_set: '设置交易密码',
  passkey_registered: '注册 Passkey',
  passkey_deleted: '删除 Passkey',
  login_failed: '登录失败',
  mandate_created: '创建常设授权',
  mandate_executed: '授权自动执行',
  mandate_failed: '授权执行失败',
  mandate_ended: '授权结束',
  mandate_revoked: '撤销授权',
  profile_generated: '生成用户画像',
  risk_flag_added: '收款账户风险标记',
  risk_flag_reviewed: '人工复核收款风险',
  risk_analysis_failed: '收款风险分析暂不可用',
}

const truncate = (text: string, max = 120) => (text.length > max ? `${text.slice(0, max)}…` : text)

function parse(json: string): Record<string, unknown> {
  try {
    const value = JSON.parse(json)
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

const asString = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback)

/** 事实摘要：只保留能解释"为什么升级"的字段，避免把整份事实堆到界面上 */
export function summarizeFacts(facts: Record<string, unknown> | null): Array<{ label: string; value: string }> {
  if (!facts) return []
  const out: Array<{ label: string; value: string }> = []
  if (typeof facts.dailyOutgoingCents === 'number') out.push({ label: '今日已转出', value: `¥${(facts.dailyOutgoingCents / 100).toFixed(2)}` })
  if (facts.payeeAgeDays === undefined) out.push({ label: '收款人', value: '未登记 / 新收款人' })
  else if (typeof facts.payeeAgeDays === 'number') out.push({ label: '收款人登记', value: `${facts.payeeAgeDays} 天` })
  if (typeof facts.recentTransferCount === 'number') out.push({ label: '近10分钟转账', value: `${facts.recentTransferCount} 笔` })
  if (facts.accountLocked === true) out.push({ label: '账户状态', value: '已锁定' })
  if (typeof facts.channel === 'string') out.push({ label: '渠道', value: facts.channel })
  return out
}

export function buildTraces(entries: TraceInput[]): Trace[] {
  const rows = [...entries].sort((a, b) => a.seq - b.seq)
  const traces: Trace[] = []
  const byAction = new Map<string, Trace>()
  // 按会话维护"当前链"：后台人工命令、定时任务、认证事件各有自己的 sessionId，
  // 不能挂到上一个用户的请求链上。
  const currentBySession = new Map<string, Trace>()

  const open = (row: TraceInput, request: string): Trace => {
    const trace: Trace = {
      id: `trace_${row.seq}`,
      sessionId: row.sessionId,
      channel: row.channel,
      startedAt: row.at,
      endedAt: row.at,
      request,
      guard: null,
      tools: [],
      level: null,
      allowed: null,
      reasons: [],
      facts: null,
      outcome: 'open',
      verified: 0,
      redacted: 0,
      steps: [],
    }
    traces.push(trace)
    currentBySession.set(row.sessionId, trace)
    return trace
  }

  /** 取该会话当前的链；没有就新开一条 */
  const currentFor = (row: TraceInput, fallbackRequest = '（系统事件）'): Trace =>
    currentBySession.get(row.sessionId) ?? open(row, fallbackRequest)

  const push = (trace: Trace, row: TraceInput, label: string, tone: StepTone, detail: string) => {
    trace.steps.push({ seq: row.seq, at: row.at, type: row.type, label, tone, detail, hash: row.hash })
    trace.endedAt = row.at
  }

  for (const row of rows) {
    const payload = parse(row.payloadJson)

    switch (row.type) {
      case 'user_input': {
        const trace = open(row, truncate(asString(payload.text, '（无正文）')))
        push(trace, row, LABELS.user_input, 'neutral', trace.request)
        break
      }

      case 'guard_verdict': {
        const trace = currentFor(row)
        const verdict = asString(payload.verdict, 'allow')
        const categories = Array.isArray(payload.categories) ? payload.categories.map(String) : []
        trace.guard = {
          verdict,
          score: typeof payload.score === 'number' ? payload.score : 0,
          categories,
          provider: asString(payload.provider, 'unknown'),
        }
        push(
          trace,
          row,
          LABELS.guard_verdict,
          verdict === 'block' ? 'danger' : verdict === 'flag' ? 'yellow' : 'green',
          verdict === 'allow' ? '放行（未发现注入特征）' : `判定 ${verdict}；分类 ${categories.join('、') || '无'}；可疑度 ${trace.guard.score}`,
        )
        break
      }

      case 'tool_call': {
        const trace = currentFor(row)
        const tool = asString(payload.tool, '未知工具')
        if (!trace.tools.includes(tool)) trace.tools.push(tool)
        push(trace, row, `${LABELS.tool_call}：${tool}`, 'neutral', truncate(JSON.stringify(payload.args ?? {}), 200))
        break
      }

      case 'policy_decision': {
        const actionId = asString(payload.actionId)
        const trace = (actionId && byAction.get(actionId)) || currentFor(row)
        const decision = asRecord(payload.decision)
        const facts = asRecord(payload.facts)
        const level = asString(decision.level, 'green') as 'green' | 'yellow' | 'red'
        const allowed = decision.allowed !== false
        const reasons = Array.isArray(decision.reasons) ? decision.reasons.map(String) : []
        // 以最后一次判定为准：确认时会按执行时事实重新采集并复判
        trace.level = level
        trace.allowed = allowed
        trace.reasons = reasons
        trace.facts = Object.keys(facts).length ? facts : trace.facts
        const stage = asString(payload.stage, 'request')
        push(
          trace,
          row,
          LABELS.policy_decision,
          !allowed ? 'danger' : level === 'red' ? 'red' : level === 'yellow' ? 'yellow' : 'green',
          [
            `阶段 ${stage === 'execution' ? '执行时复判' : stage === 'scheduled_execution' ? '定时执行复判' : stage === 'mandate_execution' ? '授权执行复判' : '发起时'}`,
            `等级 ${level}${allowed ? '' : '（直接拒绝）'}`,
            reasons.length ? `命中规则：${reasons.join('；')}` : '未命中升级规则',
          ].join(' · '),
        )
        break
      }

      case 'pending_created': {
        const trace = currentFor(row)
        const actionId = asString(payload.actionId)
        const level = asString(payload.level, 'yellow') as 'yellow' | 'red'
        if (actionId) byAction.set(actionId, trace)
        push(trace, row, LABELS.pending_created, level === 'red' ? 'red' : 'yellow', `确认单 ${actionId}，等待用户操作`)
        break
      }

      case 'confirm_attempt': {
        const trace = byAction.get(asString(payload.actionId)) ?? currentFor(row)
        const ok = payload.ok === true
        const cancelled = payload.cancelled === true
        push(
          trace,
          row,
          LABELS.confirm_attempt,
          ok ? 'green' : cancelled ? 'neutral' : 'danger',
          cancelled ? '用户取消' : ok ? '校验通过，开始执行' : asString(payload.message, asString(payload.code, '校验未通过')),
        )
        break
      }

      case 'action_executed': {
        const trace = byAction.get(asString(payload.actionId)) ?? currentFor(row)
        push(trace, row, LABELS.action_executed, 'green', truncate(JSON.stringify(payload.output ?? {}), 160))
        break
      }

      case 'action_compensated': {
        const trace = byAction.get(asString(payload.actionId)) ?? currentFor(row)
        push(trace, row, LABELS.action_compensated, 'yellow', `逆序补偿 ${asString(payload.tool, '')}`.trim())
        break
      }

      case 'tool_result': {
        const trace = byAction.get(asString(payload.actionId)) ?? currentFor(row)
        const ok = payload.ok !== false
        push(
          trace,
          row,
          LABELS.tool_result,
          ok ? 'neutral' : 'danger',
          ok ? truncate(JSON.stringify(payload.output ?? {}), 160) : asString(payload.message, '执行失败'),
        )
        break
      }

      case 'injection_redacted': {
        const trace = currentFor(row)
        trace.redacted += 1
        push(trace, row, LABELS.injection_redacted, 'danger', `${asString(payload.tool, '')} 的 ${asString(payload.field, '外部字段')} 被替换为占位符`)
        break
      }

      case 'output_verification': {
        const trace = currentFor(row)
        const violations = Array.isArray(payload.violations) ? payload.violations : []
        trace.verified += violations.length
        push(trace, row, LABELS.output_verification, 'danger', `${violations.length} 处数字没有数据出处`)
        break
      }

      case 'circuit_breaker': {
        const trace = currentFor(row)
        push(trace, row, LABELS.circuit_breaker, 'danger', asString(payload.reason, '触发安全锁定'))
        break
      }

      default: {
        const trace = currentFor(row)
        push(trace, row, LABELS[row.type] ?? row.type, 'neutral', truncate(row.payloadJson, 160))
        break
      }
    }
  }

  for (const trace of traces) {
    const types = trace.steps.map((s) => s.type)
    const executed = types.includes('action_executed')
    const compensated = types.includes('action_compensated')
    const pending = types.includes('pending_created')
    const denied = trace.steps.some((s) => s.label === LABELS.policy_decision && s.tone === 'danger')
    const failed = trace.steps.some(
      (s) => (s.type === 'tool_result' && s.tone === 'danger') || (s.type === 'confirm_attempt' && s.tone === 'danger'),
    )
    const blocked = trace.guard?.verdict === 'block'
    trace.outcome = failed
      ? 'failed'
      : compensated
        ? 'compensated'
        : executed
          ? 'confirmed'
          : pending
            ? 'pending'
            : denied
              ? 'denied'
              : blocked
                ? 'blocked'
                : types.includes('tool_result')
                  ? 'ok'
                  : 'open'
  }

  return traces.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))
}
