import { createHash, randomUUID } from 'node:crypto'
import { and, desc, eq, sql } from 'drizzle-orm'
import { db, schema } from '#/server/db/client'
import { audit } from '#/server/audit/log'
import type { AgentContext } from '#/server/agent/context'
import { withUserExecutionLock } from '#/server/confirm/lock'
import { collectFacts } from '#/server/policy/facts'
import { decide } from '#/server/policy/engine'
import { paymentAccounts, settleTransfer } from '#/server/payments/service'
import { notify } from './service'
import { parseRiskAcknowledgement, riskAcknowledged } from '#/server/risk/recipient'

/**
 * 常设授权：用户一次红色强验证，授权在有限期内按周期向固定收款人转固定金额。
 *
 * 与既有"定时转账"的区别：定时转账是一次性的；这里是一份带硬上限的长期授权。
 * 约束全部在代码里强制，模型只能创建（红色确认）、查询、撤销，**没有任何触发执行的入口**：
 *
 *   创建  create_standing_mandate → 红色确认单 → 强验证 → createMandate()
 *   执行  worker 到期扫描 → runDueMandates() → 逐项检查 → settleTransfer()（同一事务内扣减额度）
 *
 * 红线：
 * 1. 执行只能由 worker / 后台推进时钟触发，工具集里没有"立即执行"。
 * 2. 次数、累计金额、授权期在结算事务内条件更新；任何一项不满足整笔回滚，未扣款。
 * 3. 收款人信息（账号、户名、银行）变化即暂停，不会自动转向新账号。
 */

// ── 限额与常量 ────────────────────────────────────────────────────────────────

export const MANDATE_LIMITS = {
  /** 单次金额上限（分），即"单次上限"：每次执行恰好转这个金额 */
  maxPerExecutionCents: 2_000_000,
  /** 授权期内累计上限（分） */
  maxTotalCents: 10_000_000,
  maxExecutions: 31,
  maxValidityDays: 90,
  defaultValidityDays: 30,
  /** 同一用户同时有效的授权数 */
  maxActivePerUser: 5,
  /** 连续失败达到该次数即暂停，等待用户处理 */
  maxFailures: 3,
  retryDelayMs: 6 * 3600_000,
} as const

const TZ = 8 * 3600_000
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

export type MandateStatus = 'active' | 'revoked' | 'expired' | 'exhausted' | 'suspended'

// ── 频率 ──────────────────────────────────────────────────────────────────────

export interface Cadence {
  every: 'daily' | 'weekly' | 'monthly'
  /** 1=周一 … 7=周日，仅 weekly */
  weekday?: number
  /** 1–28，仅 monthly；不开放 29–31，避免小月没有该日期 */
  dayOfMonth?: number
  /** 北京时间 HH:mm */
  time: string
}

export interface CadenceInput {
  every: 'daily' | 'weekly' | 'monthly'
  weekday?: number
  dayOfMonth?: number
  time?: string
}

export function normalizeCadence(input: CadenceInput): Cadence {
  const time = input.time ?? '09:00'
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('执行时间格式应为 HH:mm，例如 09:00')
  if (input.every === 'daily') return { every: 'daily', time }
  if (input.every === 'weekly') {
    if (!Number.isInteger(input.weekday) || input.weekday! < 1 || input.weekday! > 7) throw new Error('每周执行请指定星期几（1=周一 … 7=周日）')
    return { every: 'weekly', weekday: input.weekday, time }
  }
  if (!Number.isInteger(input.dayOfMonth) || input.dayOfMonth! < 1 || input.dayOfMonth! > 28) {
    throw new Error('每月执行日请选择 1–28 日（29–31 日在部分月份不存在）')
  }
  return { every: 'monthly', dayOfMonth: input.dayOfMonth, time }
}

export function describeCadence(c: Cadence): string {
  if (c.every === 'daily') return `每天 ${c.time}`
  if (c.every === 'weekly') return `每周${WEEKDAYS[(c.weekday ?? 1) - 1]} ${c.time}`
  return `每月 ${c.dayOfMonth} 日 ${c.time}`
}

/** 严格晚于 `after` 的下一个执行时刻。按北京时间计算，返回真实时间点。 */
export function nextOccurrence(c: Cadence, after: Date): Date {
  const [h, m] = c.time.split(':').map(Number)
  const local = new Date(after.getTime() + TZ)
  const y = local.getUTCFullYear(), mo = local.getUTCMonth(), d = local.getUTCDate()
  const at = (yy: number, mm: number, dd: number) => new Date(Date.UTC(yy, mm, dd, h, m) - TZ)
  if (c.every === 'daily') {
    const today = at(y, mo, d)
    return today > after ? today : at(y, mo, d + 1)
  }
  if (c.every === 'weekly') {
    const dow = ((local.getUTCDay() + 6) % 7) + 1
    const delta = (c.weekday! - dow + 7) % 7
    const t = at(y, mo, d + delta)
    return t > after ? t : at(y, mo, d + delta + 7)
  }
  const t = at(y, mo, c.dayOfMonth!)
  return t > after ? t : at(y, mo + 1, c.dayOfMonth!)
}

export function countOccurrences(c: Cadence, from: Date, until: Date, cap: number): number {
  let n = 0
  for (let t = nextOccurrence(c, from); t <= until && n < cap; t = nextOccurrence(c, t)) n++
  return n
}

/** 两次执行之间的硬间隔，由频率推导，不由模型指定 */
export function minIntervalHoursFor(c: Cadence): number {
  return c.every === 'daily' ? 20 : c.every === 'weekly' ? 6 * 24 : 27 * 24
}

export function payeeFingerprint(p: { accountNo: string; name: string; bank: string }): string {
  return createHash('sha256').update(`${p.accountNo}|${p.name}|${p.bank}`).digest('hex').slice(0, 24)
}

// ── 建表（沿用项目里幂等升级的手法） ────────────────────────────────────────────

let ready: Promise<void> | undefined
export function ensureMandateSchema() {
  return (ready ??= (async () => {
    for (const statement of [
      `CREATE TABLE IF NOT EXISTS bank_standing_mandates (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, from_account_id TEXT NOT NULL, payee_id TEXT NOT NULL,
        payee_name TEXT NOT NULL, payee_fingerprint TEXT NOT NULL, amount_cents INTEGER NOT NULL, memo TEXT NOT NULL DEFAULT '',
        cadence_json TEXT NOT NULL, max_executions INTEGER NOT NULL, max_total_cents INTEGER NOT NULL, min_interval_hours INTEGER NOT NULL,
        executions_done INTEGER NOT NULL DEFAULT 0, total_spent_cents INTEGER NOT NULL DEFAULT 0, failure_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL, authorized_action_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        next_due_at INTEGER NOT NULL, last_executed_at INTEGER, ended_at INTEGER, ended_reason TEXT)`,
      'CREATE UNIQUE INDEX IF NOT EXISTS bank_mandate_action ON bank_standing_mandates(authorized_action_id)',
      `CREATE TABLE IF NOT EXISTS bank_mandate_executions (
        id TEXT PRIMARY KEY, mandate_id TEXT NOT NULL, seq INTEGER NOT NULL, transaction_id TEXT NOT NULL,
        amount_cents INTEGER NOT NULL, executed_at INTEGER NOT NULL)`,
      'CREATE UNIQUE INDEX IF NOT EXISTS bank_mandate_seq ON bank_mandate_executions(mandate_id, seq)',
    ]) await db.$client.execute(statement)
    const columns = await db.$client.execute('PRAGMA table_info(bank_standing_mandates)')
    if (!columns.rows.some((row) => row.name === 'payee_risk_json')) {
      try { await db.$client.execute('ALTER TABLE bank_standing_mandates ADD COLUMN payee_risk_json TEXT') }
      catch (error) { if (!String(error).includes('duplicate column name')) throw error }
    }
  })().catch((error) => {
    ready = undefined
    throw error
  }))
}

// ── 创建 ──────────────────────────────────────────────────────────────────────

export interface MandateRequest {
  fromAccountId: string
  payeeId: string
  amountCents: number
  cadence: CadenceInput
  validityDays?: number
  maxExecutions?: number
  memo?: string
}

/** 冻结进确认单、参与参数指纹的完整方案。时间戳不在其中，确认那一刻才起算。 */
export interface MandatePlan {
  fromAccountId: string
  fromAccountName: string
  payeeId: string
  payeeName: string
  payeeFingerprint: string
  amountCents: number
  cadence: Cadence
  validityDays: number
  maxExecutions: number
  maxTotalCents: number
  minIntervalHours: number
  memo: string
}

const yuan = (cents: number) => `¥${(cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** 校验请求并推导出完整方案。所有错误都用中文说明，直接回给用户。 */
export async function planMandate(userId: string, request: MandateRequest, now: Date): Promise<MandatePlan> {
  if (!Number.isSafeInteger(request.amountCents) || request.amountCents <= 0) throw new Error('每次金额无效')
  if (request.amountCents > MANDATE_LIMITS.maxPerExecutionCents) {
    throw new Error(`定期转账单次金额最高 ${yuan(MANDATE_LIMITS.maxPerExecutionCents)}，更大金额请使用单笔转账并强验证`)
  }
  const cadence = normalizeCadence(request.cadence)
  const validityDays = request.validityDays ?? MANDATE_LIMITS.defaultValidityDays
  if (!Number.isInteger(validityDays) || validityDays < 1 || validityDays > MANDATE_LIMITS.maxValidityDays) {
    throw new Error(`授权有效期须在 1–${MANDATE_LIMITS.maxValidityDays} 天之间`)
  }

  // 发起阶段就检查名额，避免用户完成一次强验证后才被告知失败
  await ensureMandateSchema()
  const [active] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.bankStandingMandates)
    .where(and(eq(schema.bankStandingMandates.userId, userId), eq(schema.bankStandingMandates.status, 'active')))
  if (Number(active?.n ?? 0) >= MANDATE_LIMITS.maxActivePerUser) {
    throw new Error(`同时有效的定期转账授权最多 ${MANDATE_LIMITS.maxActivePerUser} 个，请先撤销不再需要的授权`)
  }

  const accounts = await paymentAccounts(userId)
  const account = accounts.find((a) => a.id === request.fromAccountId)
  if (!account) throw new Error('付款账户不存在或不是可转账的储蓄账户')

  const [payee] = await db
    .select()
    .from(schema.payees)
    .where(and(eq(schema.payees.id, request.payeeId), eq(schema.payees.userId, userId)))
  if (!payee) throw new Error('收款人不存在，请先添加收款人')

  const until = new Date(now.getTime() + validityDays * 86400_000)
  const possible = countOccurrences(cadence, now, until, MANDATE_LIMITS.maxExecutions)
  if (possible === 0) throw new Error('授权有效期内不会有执行时间，请延长有效期或调整执行日')
  const maxExecutions = Math.min(request.maxExecutions ?? possible, possible)
  if (!Number.isInteger(maxExecutions) || maxExecutions < 1) throw new Error('执行次数无效')

  const maxTotalCents = request.amountCents * maxExecutions
  if (maxTotalCents > MANDATE_LIMITS.maxTotalCents) {
    throw new Error(`授权期内累计最多 ${yuan(MANDATE_LIMITS.maxTotalCents)}，当前方案共 ${yuan(maxTotalCents)}，请降低金额或次数`)
  }

  return {
    fromAccountId: account.id,
    fromAccountName: account.name,
    payeeId: payee.id,
    payeeName: payee.name,
    payeeFingerprint: payeeFingerprint(payee),
    amountCents: request.amountCents,
    cadence,
    validityDays,
    maxExecutions,
    maxTotalCents,
    minIntervalHours: minIntervalHoursFor(cadence),
    memo: (request.memo ?? '').slice(0, 50),
  }
}

/**
 * 生效。只能在红色强验证通过后调用：`ctx.authorization` 由确认服务写入，模型与客户端无法伪造。
 * `plan` 来自已签名的待确认动作参数，这里不接受任何模型实时提供的数值。
 */
export async function createMandate(ctx: AgentContext, plan: MandatePlan, now: Date) {
  if (ctx.authorization?.level !== 'red') throw new Error('常设授权必须通过强验证后才能生效')
  await ensureMandateSchema()
  const actionId = ctx.authorization.actionId

  const [active] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.bankStandingMandates)
    .where(and(eq(schema.bankStandingMandates.userId, ctx.userId), eq(schema.bankStandingMandates.status, 'active')))
  if (Number(active?.n ?? 0) >= MANDATE_LIMITS.maxActivePerUser) {
    throw new Error(`同时有效的定期转账授权最多 ${MANDATE_LIMITS.maxActivePerUser} 个，请先撤销不再需要的授权`)
  }

  // 收款人在确认期间被改动时拒绝生效
  const [payee] = await db
    .select()
    .from(schema.payees)
    .where(and(eq(schema.payees.id, plan.payeeId), eq(schema.payees.userId, ctx.userId)))
  if (!payee || payeeFingerprint(payee) !== plan.payeeFingerprint) throw new Error('收款人信息已变化，请重新发起')

  const id = `mandate_${randomUUID()}`
  const expiresAt = new Date(now.getTime() + plan.validityDays * 86400_000)
  const nextDueAt = nextOccurrence(plan.cadence, now)
  await db.insert(schema.bankStandingMandates).values({
    id,
    userId: ctx.userId,
    fromAccountId: plan.fromAccountId,
    payeeId: plan.payeeId,
    payeeName: plan.payeeName,
    payeeFingerprint: plan.payeeFingerprint,
    amountCents: plan.amountCents,
    memo: plan.memo,
    cadenceJson: JSON.stringify(plan.cadence),
    maxExecutions: plan.maxExecutions,
    maxTotalCents: plan.maxTotalCents,
    minIntervalHours: plan.minIntervalHours,
    status: 'active',
    authorizedActionId: actionId,
    payeeRiskJson: ctx.authorization.payeeRisk ? JSON.stringify(ctx.authorization.payeeRisk) : null,
    createdAt: now,
    expiresAt,
    nextDueAt,
  })
  await audit(ctx, 'mandate_created', {
    mandateId: id,
    actionId,
    payeeId: plan.payeeId,
    amountCents: plan.amountCents,
    cadence: plan.cadence,
    maxExecutions: plan.maxExecutions,
    maxTotalCents: plan.maxTotalCents,
    expiresAt: expiresAt.toISOString(),
  })
  return { mandateId: id, nextDueAt: nextDueAt.toISOString(), expiresAt: expiresAt.toISOString() }
}

// ── 查询与撤销 ────────────────────────────────────────────────────────────────

export type MandateView = ReturnType<typeof toView>

function toView(row: typeof schema.bankStandingMandates.$inferSelect) {
  const cadence = JSON.parse(row.cadenceJson) as Cadence
  return {
    id: row.id,
    payeeName: row.payeeName,
    amount: row.amountCents / 100,
    cadence: describeCadence(cadence),
    status: row.status as MandateStatus,
    executionsDone: row.executionsDone,
    maxExecutions: row.maxExecutions,
    totalSpent: row.totalSpentCents / 100,
    maxTotal: row.maxTotalCents / 100,
    minIntervalDays: Math.round((row.minIntervalHours / 24) * 10) / 10,
    nextDueAt: row.status === 'active' ? row.nextDueAt.toISOString() : null,
    expiresAt: row.expiresAt.toISOString(),
    lastExecutedAt: row.lastExecutedAt?.toISOString() ?? null,
    endedReason: row.endedReason,
    memo: row.memo,
  }
}

export async function listMandates(userId: string) {
  await ensureMandateSchema()
  const rows = await db
    .select()
    .from(schema.bankStandingMandates)
    .where(eq(schema.bankStandingMandates.userId, userId))
    .orderBy(desc(schema.bankStandingMandates.createdAt))
    .limit(50)
  return rows.map(toView)
}

/**
 * 撤销。只要求已登录，不设强验证：停止是安全方向的操作。
 * 条件更新使撤销与正在进行的执行互斥——执行的结算事务要求 status='active'，撤销后它会整笔回滚。
 */
export async function revokeMandate(ctx: AgentContext, mandateId: string, reason = '用户撤销') {
  await ensureMandateSchema()
  const [row] = await db
    .update(schema.bankStandingMandates)
    .set({ status: 'revoked', endedAt: new Date(), endedReason: reason })
    .where(
      and(
        eq(schema.bankStandingMandates.id, mandateId),
        eq(schema.bankStandingMandates.userId, ctx.userId),
        sql`${schema.bankStandingMandates.status} IN ('active', 'suspended')`,
      ),
    )
    .returning()
  if (!row) throw new Error('授权不存在，或已经结束')
  await audit(ctx, 'mandate_revoked', { mandateId, reason })
  return toView(row)
}

// ── 执行 ──────────────────────────────────────────────────────────────────────

export interface MandateRunResult {
  mandateId: string
  status: 'executed' | 'ended' | 'failed' | 'suspended'
  message: string
}

/** 扫描并执行该用户所有到期的授权。由 worker 与后台推进时钟调用，不对模型暴露。 */
export async function runDueMandates(userId: string, now: Date): Promise<MandateRunResult[]> {
  await ensureMandateSchema()
  const rows = await db
    .select({ id: schema.bankStandingMandates.id })
    .from(schema.bankStandingMandates)
    .where(and(eq(schema.bankStandingMandates.userId, userId), eq(schema.bankStandingMandates.status, 'active')))
  const results: MandateRunResult[] = []
  for (const { id } of rows) {
    const result = await withUserExecutionLock(userId, () => executeOne(userId, id, now))
    if (result) results.push(result)
  }
  return results
}

async function executeOne(userId: string, id: string, now: Date): Promise<MandateRunResult | null> {
  const t = schema.bankStandingMandates
  // 加锁后重新读取：期间可能已被撤销或被另一个进程执行
  const [m] = await db.select().from(t).where(and(eq(t.id, id), eq(t.userId, userId), eq(t.status, 'active')))
  if (!m) return null
  const ctx: AgentContext = { userId, sessionId: `mandate:${id}`, channel: 'web' }
  const cadence = JSON.parse(m.cadenceJson) as Cadence

  const end = async (status: 'expired' | 'exhausted' | 'suspended', title: string, body: string): Promise<MandateRunResult> => {
    const [changed] = await db
      .update(t)
      .set({ status, endedAt: now, endedReason: body })
      .where(and(eq(t.id, id), eq(t.status, 'active')))
      .returning({ id: t.id })
    if (changed) {
      await audit(ctx, 'mandate_ended', { mandateId: id, status, reason: body })
      await notify(userId, 'mandate', title, body, `mandate:${id}:${status}`)
    }
    return { mandateId: id, status: status === 'suspended' ? 'suspended' : 'ended', message: body }
  }

  if (m.expiresAt <= now) return end('expired', '定期转账授权已到期', `${m.payeeName} 的定期转账授权已过有效期，不会再自动转账。如需继续请重新授权。`)
  if (m.executionsDone >= m.maxExecutions || m.totalSpentCents + m.amountCents > m.maxTotalCents) {
    return end('exhausted', '定期转账授权已用完', `${m.payeeName} 的定期转账已达到授权的次数或金额上限。如需继续请重新授权。`)
  }
  if (m.nextDueAt > now) return null
  if (m.lastExecutedAt && now.getTime() - m.lastExecutedAt.getTime() < m.minIntervalHours * 3600_000) return null

  // 收款人信息变化：暂停，绝不自动转向变化后的账号
  const [payee] = await db.select().from(schema.payees).where(and(eq(schema.payees.id, m.payeeId), eq(schema.payees.userId, userId)))
  if (!payee || payeeFingerprint(payee) !== m.payeeFingerprint) {
    return end('suspended', '定期转账已暂停', `${m.payeeName} 的收款信息发生变化，授权已暂停。请核对后重新授权。`)
  }

  // 复判：授权本身是红色强验证，这里的作用是让"拒绝类"规则（熔断、账户锁定）继续生效，并留下可审计的判定
  const facts = await collectFacts({ userId, channel: 'web', payeeId: m.payeeId, now })
  const decision = decide({
    tool: 'execute_standing_mandate',
    baseRisk: 'red',
    args: { amountCents: m.amountCents, payeeId: m.payeeId },
    facts,
  })
  await audit(ctx, 'policy_decision', { mandateId: id, stage: 'mandate_execution', tool: 'execute_standing_mandate', decision, facts })
  const payeeRisk = parseRiskAcknowledgement(m.payeeRiskJson)
  if (!riskAcknowledged(facts, payeeRisk) || facts.payeeRiskFlag === 'confirmed') {
    return end('suspended', '定期转账已暂停', '收款账户风险标记已变化，请核实对方身份；可重新强验证授权或联系人工复核。')
  }

  const fail = async (message: string): Promise<MandateRunResult> => {
    const failures = m.failureCount + 1
    const suspend = failures >= MANDATE_LIMITS.maxFailures
    await db
      .update(t)
      .set({
        failureCount: failures,
        nextDueAt: new Date(now.getTime() + MANDATE_LIMITS.retryDelayMs),
        ...(suspend ? { status: 'suspended', endedAt: now, endedReason: `连续 ${failures} 次执行失败：${message}` } : {}),
      })
      .where(and(eq(t.id, id), eq(t.status, 'active')))
    await audit(ctx, 'mandate_failed', { mandateId: id, failures, message, suspended: suspend })
    await notify(
      userId,
      'mandate',
      suspend ? '定期转账已暂停' : '定期转账未成功',
      suspend ? `${m.payeeName} 的定期转账连续失败，授权已暂停：${message}` : `${m.payeeName} 的定期转账本次未成功：${message}。系统稍后重试。`,
      `mandate:${id}:fail:${failures}`,
    ).catch(() => {})
    return { mandateId: id, status: suspend ? 'suspended' : 'failed', message }
  }

  if (!decision.allowed) return fail(decision.reasons.join('；'))

  try {
    const seq = m.executionsDone + 1
    const receipt = await settleTransfer(
      { fromAccountId: m.fromAccountId, payeeId: m.payeeId, amountCents: m.amountCents, memo: m.memo || '定期转账' },
      { ...ctx, authorization: { level: 'red', actionId: m.authorizedActionId, payeeRisk } },
      now,
      {
        // 与扣款同一个事务：额度、次数、授权期任何一项不满足，整笔回滚，不扣款
        onSettled: async (tx, transactionId) => {
          const [updated] = await tx
            .update(t)
            .set({
              executionsDone: sql`${t.executionsDone} + 1`,
              totalSpentCents: sql`${t.totalSpentCents} + ${m.amountCents}`,
              lastExecutedAt: now,
              nextDueAt: nextOccurrence(cadence, now),
              failureCount: 0,
              status: sql`CASE WHEN ${t.executionsDone} + 1 >= ${t.maxExecutions} OR ${t.totalSpentCents} + ${m.amountCents} + ${m.amountCents} > ${t.maxTotalCents} THEN 'exhausted' ELSE 'active' END`,
            })
            .where(
              and(
                eq(t.id, id),
                eq(t.status, 'active'),
                eq(t.executionsDone, m.executionsDone),
                sql`${t.executionsDone} < ${t.maxExecutions}`,
                sql`${t.totalSpentCents} + ${m.amountCents} <= ${t.maxTotalCents}`,
                sql`${t.expiresAt} > ${now.getTime()}`,
              ),
            )
            .returning({ id: t.id })
          if (!updated) throw new Error('授权状态已变化，本次未扣款')
          await tx.insert(schema.bankMandateExecutions).values({
            id: `mexec_${randomUUID()}`,
            mandateId: id,
            seq,
            transactionId,
            amountCents: m.amountCents,
            executedAt: now,
          })
        },
      },
    )
    await audit(ctx, 'mandate_executed', { mandateId: id, seq, transactionId: receipt.transactionId, amountCents: m.amountCents }).catch((error) =>
      console.error('[mandate] 已扣款，审计写入失败', String(error)),
    )
    await notify(
      userId,
      'mandate',
      '定期转账已执行',
      `已按授权向 ${m.payeeName} 转账 ${yuan(m.amountCents)}（第 ${seq}/${m.maxExecutions} 次）。`,
      `mandate:${id}:done:${seq}`,
    ).catch((error) => console.error('[mandate] 已扣款，通知失败', String(error)))
    return { mandateId: id, status: 'executed', message: `第 ${seq} 次，${yuan(m.amountCents)}` }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
}
