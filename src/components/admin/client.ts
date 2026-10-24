/**
 * 管理后台 API 客户端（对接 /api/admin）
 */

import type { RuntimeLogSnapshot } from '#/lib/runtime-logs'

export type AdminUser = {
  id: string
  name: string
  phoneNumber: string | null
  accountCount: number
  balanceCents: number
  riskLevel: string
  locked: boolean
}

export type AdminSnapshot = {
  now: string
  user: { id: string; name: string; riskLevel: string; riskAssessedAt: string | null }
  account: { id: string; name: string; balance: number; available: number; held: number }
  accounts: Array<{ id: string; name: string; balanceCents: number; balance: number; available: number }>
  contacts: Array<{ id: string; name: string; phone: string; note: string; bank: string; accountMask: string }>
  cards: Array<{ id: string; accountId: string; remark: string; last4: string; kind: string; status: string; dailyLimit: number; creditLimit: number; outstanding: number; onlineEnabled: boolean }>
  products: Array<{ id: string; name: string; riskLevel: string; minAmount: number; annualRate: number; lockDays: number; description: string }>
  holdings: Array<{ id: string; productId: string; principal: number; redeemableAt: string }>
  subscriptions: Array<{ id: string; merchant: string; amount: number; cycle: string; status: string; nextChargeAt: string | null; remindDays: number; lastReminderAt: string | null }>
  tasks: Array<{ id: string; kind: string; status: string; dueAt: string; payload: Record<string, unknown>; result: Record<string, unknown> | null }>
  splits: Array<{ id: string; title: string; total: number; shares: Array<{ contactId: string; amount: number; status: string }>; selfAmount: number; createdAt: string }>
  plans: Array<{ id: string; contactId: string; birthday: string; budget: number; status: string; createdAt: string }>
  orders: Array<{ id: string; planId: string; merchant: string; item: string; amount: number; deliveryDate: string; status: string }>
  transactions: Array<{ id: string; accountId: string; amount: number; merchant: string; category: string; occurredAt: string; reference: string; subscriptionId: string | null }>
  auditLogs: Array<{ seq: number; at: string; userId: string; sessionId: string; channel: string; type: string; payloadJson: string; hash: string }>
}

export type AdminReport = {
  period: string
  income: number
  expense: number
  net: number
  transactionCount: number
  categories: Record<string, number>
  excludedCategories: string[]
}

export type AdminAnomaly = {
  id: string
  amount: number
  merchant: string
  category: string
  occurredAt: string
  reasons: string[]
  needsReview: true
}

export type AdminCommand =
  | { type: 'transfer'; recipient: string; amount: number; memo?: string; executeAt?: string }
  | { type: 'createSplit'; title: string; total: number; contactIds: string[] }
  | { type: 'cancelTask'; taskId: string }
  | { type: 'assessRisk'; answers: number[] }
  | { type: 'purchase'; productId: string; amount: number }
  | { type: 'redeem'; holdingId: string; amount: number }
  | { type: 'applyCard'; kind: 'debit' | 'credit' }
  | { type: 'cardRemark'; cardId: string; remark: string }
  | { type: 'creditSpend'; cardId: string; amount: number; merchant: string }
  | { type: 'updateCard'; cardId: string; action: 'freeze' | 'unlock' | 'reportLost' | 'limits'; dailyLimit?: number; onlineEnabled?: boolean }
  | { type: 'cancelSubscription'; subscriptionId: string }
  | { type: 'subscriptionReminder'; subscriptionId: string; days: number }
  | { type: 'birthdayPlan'; contactId: string; birthday: string; budget: number }
  | { type: 'cancelPlan'; planId: string }
  | { type: 'advanceClock'; to: string }
  | { type: 'runJobs' }
  | { type: 'tamperAudit'; seq: number }
  | { type: 'restoreAudit' }

// ── 安全内核 ──────────────────────────────────────────────────────────────────

export type AuditChainEntry = {
  seq: number
  at: string
  userId: string
  channel: string
  type: string
  hash: string
  prevHash: string
  payloadJson: string
  ok: boolean
  reason: string
  tampered: boolean
}

export type AdminSecurityOverview = {
  generatedAt: string
  chain: {
    ok: boolean
    brokenAt: number
    brokenSeq: number | null
    total: number
    entries: AuditChainEntry[]
  }
  redTeam: Array<{
    id: string
    input: string
    category: string
    expect: string
    verdict: 'block' | 'flag' | 'allow'
    score: number
    categories: string[]
    passed: boolean
    caughtBy: string
  }>
  redTeamScore: { total: number; passed: number }
  policy: Array<{
    id: string
    label: string
    note: string
    tool: string
    baseRisk: 'green' | 'yellow' | 'red'
    level: 'green' | 'yellow' | 'red'
    allowed: boolean
    reasons: string[]
    requiresChannelHandoff: boolean
  }>
  stats: {
    redactedTotal: number
    outputViolations: number
    circuitBreaks: number
    pendingTotal: number
    executedTotal: number
    deniedTotal: number
  }
}

export type TraceStep = {
  seq: number
  at: string
  type: string
  label: string
  tone: 'green' | 'yellow' | 'red' | 'danger' | 'neutral'
  detail: string
  hash: string
}

export type AdminTrace = {
  id: string
  sessionId: string
  channel: string
  startedAt: string
  endedAt: string
  request: string
  guard: { verdict: string; score: number; categories: string[]; provider: string } | null
  tools: string[]
  level: 'green' | 'yellow' | 'red' | null
  allowed: boolean | null
  reasons: string[]
  facts: Record<string, unknown> | null
  outcome: 'blocked' | 'denied' | 'pending' | 'confirmed' | 'failed' | 'compensated' | 'ok' | 'open'
  verified: number
  redacted: number
  steps: TraceStep[]
}

export type SandboxProbeResult = {
  id: string
  label: string
  note: string
  code: string
  ok: boolean
  durationMs: number
  output: string
  error: string
}

export class AdminApiError extends Error {
  constructor(public code: string, message: string) { super(message) }
}

const BASE = '/api/admin'
const accessHeaders = (): Record<string, string> => typeof window !== 'undefined' && sessionStorage.getItem('wencai_admin_token') ? { authorization: `Bearer ${sessionStorage.getItem('wencai_admin_token')}` } : {}

async function get<T>(action: string, params: Record<string, string> = {}): Promise<T> {
  const qs = new URLSearchParams({ action, ...params }).toString()
  const res = await fetch(`${BASE}?${qs}`, { headers: accessHeaders() })
  const body = await res.json()
  if (!res.ok) throw new AdminApiError(body.error?.code ?? 'ERROR', body.error?.message ?? res.statusText)
  return body.data as T
}

async function post<T>(userId: string, command: AdminCommand): Promise<T> {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { ...accessHeaders(), 'Content-Type': 'application/json', 'x-admin-user': userId },
    body: JSON.stringify(command),
  })
  const body = await res.json()
  if (!res.ok) throw new AdminApiError(body.error?.code ?? 'ERROR', body.error?.message ?? res.statusText)
  return body.data as T
}

export const adminApi = {
  logs: () => get<RuntimeLogSnapshot>('logs'),
  users: () => get<AdminUser[]>('users'),
  snapshot: (userId: string) => get<AdminSnapshot>('snapshot', { userId }),
  report: (userId: string, period: string) => get<AdminReport>('report', { userId, period }),
  anomalies: (userId: string) => get<AdminAnomaly[]>('anomalies', { userId }),
  command: (userId: string, cmd: AdminCommand) => post<unknown>(userId, cmd),
  /** 安全内核：审计链状态、红队回归、策略推演 */
  security: () => get<AdminSecurityOverview>('security'),
  /** 决策链：把审计事件按一次用户请求重新串起来 */
  trace: () => get<AdminTrace[]>('trace'),
  /** 沙箱样本执行（一次性跑完，含超时与越权用例） */
  sandbox: () => get<SandboxProbeResult[]>('sandbox'),
}
