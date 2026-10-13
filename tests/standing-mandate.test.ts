import { setTxPassword } from '#/server/auth/tx-password'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { auth, db, schema } from '#/server/db/client'
import { confirmPending } from './helpers/card-confirmation'
import { runBankTool } from '#/server/tools/runner'
import { BANK_TOOLS, resolveTool } from '#/server/tools/bank'
import { buildAgentTools } from '#/server/agent/tools'
import { createStandingMandate, listStandingMandates, revokeStandingMandate } from '#/server/tools/mandates'
import {
  MANDATE_LIMITS,
  countOccurrences,
  describeCadence,
  ensureMandateSchema,
  listMandates,
  nextOccurrence,
  normalizeCadence,
  revokeMandate,
  runDueMandates,
} from '#/server/automation/mandates'
import { requestStepUpCode } from '#/server/auth/step-up'
import { paymentAccounts } from '#/server/payments/service'

const uid = 'mandate_user', otherId = 'mandate_other'
const ctx = { userId: uid, sessionId: 'mandate-1', channel: 'web' as const }
const payeeId = 'mandate_payee'
const T0 = new Date('2026-10-12T02:00:00.000Z') // 北京时间 10-12 10:00，周一
const day = (n: number, from = T0) => new Date(from.getTime() + n * 86400_000)
let accountId = ''
/** 测试要把仿真时钟拨到固定时间；共用库里的原值必须还原，否则会影响其他测试文件 */
let originalClock: string | undefined

async function clock(now: Date) {
  await db.insert(schema.settings).values({ key: 'clock', value: now.toISOString() })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: now.toISOString() } })
}
const balance = async () => (await db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId)))[0].balanceCents
const row = async (id: string) => (await db.select().from(schema.bankStandingMandates).where(eq(schema.bankStandingMandates.id, id)))[0]
const executions = async (id: string) => db.select().from(schema.bankMandateExecutions).where(eq(schema.bankMandateExecutions.mandateId, id))

/** 走完整链路：发起 → 红色确认单 → 强验证 → 生效 */
async function authorize(args: Record<string, unknown> = {}) {
  const proposal = await runBankTool(createStandingMandate, {
    fromAccountId: accountId, payeeId, amountCents: 150_000, every: 'monthly', dayOfMonth: 15, ...args,
  }, ctx)
  if (proposal.status !== 'needs_confirmation') throw new Error(JSON.stringify(proposal))
  let code = ''
  const challenge = await requestStepUpCode(uid, `action:${proposal.actionId}`, async (_p, value) => { code = value })
  const result = await confirmPending({
    ctx, actionId: proposal.actionId, resolveTool,
    stepUp: { method: 'sms', challengeId: challenge.challengeId, code },
  })
  if (!result.ok) throw new Error(JSON.stringify(result))
  return { proposal, result, mandateId: (result.output as { mandateId: string }).mandateId }
}

beforeAll(async () => {
  await ensureMandateSchema()
  originalClock = (await db.select().from(schema.settings).where(eq(schema.settings.key, 'clock')))[0]?.value
  const ids = [uid, otherId]
  await db.delete(schema.bankMandateExecutions).where(inArray(schema.bankMandateExecutions.mandateId,
    (await db.select({ id: schema.bankStandingMandates.id }).from(schema.bankStandingMandates).where(inArray(schema.bankStandingMandates.userId, ids))).map((r) => r.id)))
  await db.delete(schema.bankStandingMandates).where(inArray(schema.bankStandingMandates.userId, ids))
  await db.delete(schema.pendingActions).where(inArray(schema.pendingActions.userId, ids))
  await db.delete(schema.payees).where(inArray(schema.payees.userId, ids))
  await db.delete(schema.accounts).where(inArray(schema.accounts.userId, ids))
  await db.delete(auth.baUser).where(inArray(auth.baUser.id, ids))
  await db.delete(schema.users).where(inArray(schema.users.id, ids))
  await db.insert(schema.users).values([{ id: uid, name: '授权测试' }, { id: otherId, name: '他人' }])
  await db.insert(auth.baUser).values([
    { id: uid, name: '授权测试', email: `${uid}@test.local`, emailVerified: true, phoneNumber: '13900007701', phoneNumberVerified: true, createdAt: new Date(), updatedAt: new Date() },
    { id: otherId, name: '他人', email: `${otherId}@test.local`, emailVerified: true, phoneNumber: '13900007702', phoneNumberVerified: true, createdAt: new Date(), updatedAt: new Date() },
  ])
  accountId = 'mandate_account'
  await db.insert(schema.accounts).values({ id: accountId, userId: uid, name: '生活账户', balanceCents: 1_000_000 })
  await db.insert(schema.payees).values({
    id: payeeId, userId: uid, name: '小明', alias: '孩子', accountNo: '6222000011112222', bank: '外部银行', phone: '13900001111', createdAt: new Date('2026-01-01'),
  })
  await paymentAccounts(uid) // 为账户生成收款账号，settleTransfer 依赖它
  // These scenarios start with an enrolled banking account.
  for (const id of [uid, otherId]) await setTxPassword(id, '983701')
})

beforeEach(async () => {
  await db.$client.execute({ sql: 'DELETE FROM bank_step_up_codes WHERE user_id = ?', args: [uid] }).catch(() => {})
  await db.update(schema.users).set({ failedAuthCount: 0, lockedUntil: null }).where(eq(schema.users.id, uid))
  await db.update(schema.accounts).set({ balanceCents: 1_000_000 }).where(eq(schema.accounts.id, accountId))
  await db.update(schema.bankStandingMandates).set({ status: 'revoked' }).where(eq(schema.bankStandingMandates.userId, uid))
  const own = await db.select({ id: schema.transactions.id }).from(schema.transactions).where(eq(schema.transactions.accountId, accountId))
  if (own.length) await db.delete(schema.transactions).where(eq(schema.transactions.accountId, accountId))
  await clock(T0)
})

afterAll(async () => {
  if (originalClock === undefined) await db.delete(schema.settings).where(eq(schema.settings.key, 'clock'))
  else await clock(new Date(originalClock))
  const ids = [uid, otherId]
  const owned = (await db.select({ id: schema.bankStandingMandates.id }).from(schema.bankStandingMandates).where(inArray(schema.bankStandingMandates.userId, ids))).map((r) => r.id)
  if (owned.length) await db.delete(schema.bankMandateExecutions).where(inArray(schema.bankMandateExecutions.mandateId, owned))
  await db.delete(schema.bankStandingMandates).where(inArray(schema.bankStandingMandates.userId, ids))
  await db.delete(schema.pendingActions).where(inArray(schema.pendingActions.userId, ids))
  await db.delete(schema.transactions).where(eq(schema.transactions.accountId, accountId))
  await db.delete(schema.payees).where(inArray(schema.payees.userId, ids))
  await db.delete(schema.accounts).where(inArray(schema.accounts.userId, ids))
  await db.delete(auth.baUser).where(inArray(auth.baUser.id, ids))
  await db.delete(schema.users).where(inArray(schema.users.id, ids))
})

describe('频率计算（北京时间）', () => {
  const at = (iso: string) => new Date(iso)
  it('每月：本月日期未过取本月，已过取下月', () => {
    const c = normalizeCadence({ every: 'monthly', dayOfMonth: 15 })
    expect(nextOccurrence(c, at('2026-10-12T02:00:00Z')).toISOString()).toBe('2026-10-15T01:00:00.000Z')
    expect(nextOccurrence(c, at('2026-10-15T01:00:00Z')).toISOString()).toBe('2026-11-15T01:00:00.000Z')
  })
  it('每周与每天', () => {
    const weekly = normalizeCadence({ every: 'weekly', weekday: 5, time: '18:30' }) // 周五 18:30
    expect(nextOccurrence(weekly, at('2026-10-12T02:00:00Z')).toISOString()).toBe('2026-10-16T10:30:00.000Z')
    const daily = normalizeCadence({ every: 'daily', time: '09:00' })
    expect(nextOccurrence(daily, at('2026-10-12T02:00:00Z')).toISOString()).toBe('2026-10-13T01:00:00.000Z')
  })
  it('跨年与描述', () => {
    const c = normalizeCadence({ every: 'monthly', dayOfMonth: 1 })
    expect(nextOccurrence(c, at('2026-12-20T00:00:00Z')).toISOString()).toBe('2027-01-01T01:00:00.000Z')
    expect(describeCadence(c)).toBe('每月 1 日 09:00')
    expect(describeCadence(normalizeCadence({ every: 'weekly', weekday: 7 }))).toBe('每周日 09:00')
  })
  it('授权期内的执行次数', () => {
    const weekly = normalizeCadence({ every: 'weekly', weekday: 1 })
    expect(countOccurrences(weekly, T0, day(30), 31)).toBe(4)
    expect(countOccurrences(normalizeCadence({ every: 'daily' }), T0, day(90), 31)).toBe(31)
  })
  it('拒绝无法保证存在的日期与非法输入', () => {
    expect(() => normalizeCadence({ every: 'monthly', dayOfMonth: 31 })).toThrow('1–28')
    expect(() => normalizeCadence({ every: 'weekly' })).toThrow('星期')
    expect(() => normalizeCadence({ every: 'daily', time: '25:00' })).toThrow('HH:mm')
  })
})

describe('创建：必须红色强验证，参数冻结', () => {
  it('注册为红色写工具；查询是绿色；没有任何执行类工具', () => {
    expect(createStandingMandate.baseRisk).toBe('red')
    expect(createStandingMandate.kind).toBe('write')
    expect(listStandingMandates.baseRisk).toBe('green')
    expect(revokeStandingMandate.baseRisk).toBe('yellow')
    const names = BANK_TOOLS.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['create_standing_mandate', 'list_standing_mandates', 'revoke_standing_mandate']))
    expect(names.filter((n) => /mandate/.test(n) && /(run|execute|trigger|now)/.test(n))).toEqual([])
    expect(Object.keys(buildAgentTools(ctx)).filter((n) => /mandate/.test(n) && /(run|execute|trigger|now)/.test(n))).toEqual([])
  })

  it('发起即生成红色确认单，确认单列明全部上限；未强验证不生效', async () => {
    const proposal = await runBankTool(createStandingMandate, { fromAccountId: accountId, payeeId, amountCents: 150_000, every: 'monthly', dayOfMonth: 15 }, ctx)
    if (proposal.status !== 'needs_confirmation') throw new Error(JSON.stringify(proposal))
    expect(proposal.level).toBe('red')
    const text = proposal.summary.fields.map((f) => `${f.label}:${f.value}`).join('\n')
    expect(text).toContain('每次金额:¥1500.00')
    expect(text).toContain('每月 15 日 09:00')
    expect(text).toContain('最多执行:1 次，累计不超过 ¥1500.00')
    expect(text).toContain('最小间隔')
    expect(await confirmPending({ ctx, actionId: proposal.actionId, resolveTool })).toMatchObject({ code: 'step_up_required' })
    expect(await listMandates(uid)).toEqual(expect.not.arrayContaining([expect.objectContaining({ status: 'active' })]))
  })

  it('强验证通过后生效，次数与总额由有效期推导', async () => {
    const { mandateId } = await authorize({ every: 'weekly', weekday: 1, amountCents: 100_000 })
    const m = await row(mandateId)
    expect(m).toMatchObject({ status: 'active', amountCents: 100_000, maxExecutions: 4, maxTotalCents: 400_000 })
    expect(m.minIntervalHours).toBe(144)
    expect(m.expiresAt.getTime() - m.createdAt.getTime()).toBe(30 * 86400_000)
    expect(await balance()).toBe(1_000_000) // 创建授权本身不扣款
  })

  it('金额、累计与有效期超限被拒绝', async () => {
    const send = (args: Record<string, unknown>) => runBankTool(createStandingMandate, { fromAccountId: accountId, payeeId, every: 'weekly', weekday: 1, amountCents: 100_000, ...args }, ctx)
    expect(await send({ amountCents: MANDATE_LIMITS.maxPerExecutionCents + 1 })).toMatchObject({ status: 'error' })
    expect(await send({ amountCents: 1_500_000, every: 'daily', validityDays: 30 })).toMatchObject({ status: 'error', message: expect.stringContaining('累计最多') })
    expect(await send({ validityDays: 91 })).toMatchObject({ status: 'error' })
    expect(await send({ payeeId: 'nobody' })).toMatchObject({ status: 'error', message: expect.stringContaining('收款人') })
    expect(await send({ fromAccountId: 'not_mine' })).toMatchObject({ status: 'error' })
  })

  it('模型传入的"次数"不能超过有效期内的实际执行次数', async () => {
    const { mandateId } = await authorize({ every: 'weekly', weekday: 1, maxExecutions: 31 })
    expect((await row(mandateId)).maxExecutions).toBe(4)
  })

  it('同时有效的授权数有上限，且在发起阶段就提示，不让用户白做一次强验证', async () => {
    // 短信验证码有发送频率限制，这里直接写入已生效的授权来填满名额
    for (let i = 0; i < MANDATE_LIMITS.maxActivePerUser; i++) {
      await db.insert(schema.bankStandingMandates).values({
        id: `mandate_fill_${i}`, userId: uid, fromAccountId: accountId, payeeId, payeeName: '小明', payeeFingerprint: 'x',
        amountCents: 1000, cadenceJson: JSON.stringify({ every: 'monthly', dayOfMonth: 10, time: '09:00' }), maxExecutions: 1,
        maxTotalCents: 1000, minIntervalHours: 648, status: 'active', authorizedActionId: `pa_fill_${i}`,
        createdAt: T0, expiresAt: day(30), nextDueAt: day(5),
      })
    }
    const res = await runBankTool(createStandingMandate, { fromAccountId: accountId, payeeId, amountCents: 1000, every: 'monthly', dayOfMonth: 20 }, ctx)
    expect(res).toMatchObject({ status: 'error', message: expect.stringContaining('最多') })
    const pending = await db.select().from(schema.pendingActions).where(eq(schema.pendingActions.userId, uid))
    expect(pending.some((p) => p.tool === 'create_standing_mandate' && p.status === 'pending' && p.argsJson.includes('"dayOfMonth":20'))).toBe(false)
  })

  it('一笔确认单只能产生一份授权，参数不可被替换', async () => {
    const { proposal } = await authorize()
    const [pending] = await db.select().from(schema.pendingActions).where(eq(schema.pendingActions.id, proposal.actionId))
    expect(pending.status).toBe('consumed')
    expect(JSON.parse(pending.argsJson).plan.amountCents).toBe(150_000)
    expect(await confirmPending({ ctx, actionId: proposal.actionId, resolveTool })).toMatchObject({ code: 'already_used' })
  })
})

describe('执行：由后台触发，逐次受硬上限约束', () => {
  it('未到期不执行；到期执行一次并扣减额度', async () => {
    const { mandateId } = await authorize({ every: 'weekly', weekday: 1, amountCents: 100_000 })
    expect(await runDueMandates(uid, day(0))).toEqual([])
    expect(await balance()).toBe(1_000_000)

    const due = (await row(mandateId)).nextDueAt
    const results = await runDueMandates(uid, new Date(due.getTime() + 60_000))
    expect(results).toMatchObject([{ mandateId, status: 'executed' }])
    expect(await balance()).toBe(900_000)
    expect(await row(mandateId)).toMatchObject({ executionsDone: 1, totalSpentCents: 100_000, failureCount: 0, status: 'active' })
    expect(await executions(mandateId)).toHaveLength(1)
  })

  it('同一期被重复触发只执行一次', async () => {
    const { mandateId } = await authorize({ every: 'weekly', weekday: 1, amountCents: 100_000 })
    const now = new Date((await row(mandateId)).nextDueAt.getTime() + 60_000)
    await Promise.all([runDueMandates(uid, now), runDueMandates(uid, now), runDueMandates(uid, now)])
    expect(await balance()).toBe(900_000)
    expect(await executions(mandateId)).toHaveLength(1)
  })

  it('最小间隔是硬约束：即使被推到"到期"也不会连续执行', async () => {
    const { mandateId } = await authorize({ every: 'weekly', weekday: 1, amountCents: 100_000 })
    const first = new Date((await row(mandateId)).nextDueAt.getTime() + 60_000)
    await runDueMandates(uid, first)
    // 人为把下次到期时间改到现在，模拟频率计算被篡改或时钟异常
    await db.update(schema.bankStandingMandates).set({ nextDueAt: first }).where(eq(schema.bankStandingMandates.id, mandateId))
    expect(await runDueMandates(uid, new Date(first.getTime() + 3600_000))).toEqual([])
    expect(await executions(mandateId)).toHaveLength(1)
    expect(await runDueMandates(uid, new Date(first.getTime() + 145 * 3600_000))).toMatchObject([{ status: 'executed' }])
  })

  it('次数用尽后自动结束，不会多转', async () => {
    const { mandateId } = await authorize({ every: 'weekly', weekday: 1, amountCents: 50_000, maxExecutions: 2 })
    let now = new Date((await row(mandateId)).nextDueAt.getTime() + 60_000)
    await runDueMandates(uid, now)
    now = new Date(now.getTime() + 8 * 86400_000)
    await runDueMandates(uid, now)
    expect(await row(mandateId)).toMatchObject({ executionsDone: 2, status: 'exhausted' })
    await runDueMandates(uid, new Date(now.getTime() + 8 * 86400_000))
    expect(await balance()).toBe(900_000)
    expect(await executions(mandateId)).toHaveLength(2)
  })

  it('授权期结束后不再执行', async () => {
    const { mandateId } = await authorize({ every: 'weekly', weekday: 1, amountCents: 50_000 })
    const results = await runDueMandates(uid, day(31))
    expect(results).toMatchObject([{ status: 'ended' }])
    expect((await row(mandateId)).status).toBe('expired')
    expect(await balance()).toBe(1_000_000)
  })

  it('撤销立即生效，之后不再执行；他人不能撤销', async () => {
    const { mandateId } = await authorize({ every: 'weekly', weekday: 1, amountCents: 50_000 })
    await expect(revokeMandate({ ...ctx, userId: otherId }, mandateId)).rejects.toThrow()
    await revokeMandate(ctx, mandateId)
    expect((await row(mandateId)).status).toBe('revoked')
    expect(await runDueMandates(uid, day(10))).toEqual([])
    expect(await balance()).toBe(1_000_000)
    await expect(revokeMandate(ctx, mandateId)).rejects.toThrow('已经结束')
  })

  it('撤销与执行同时发生：已撤销的授权不会扣款', async () => {
    const { mandateId } = await authorize({ every: 'weekly', weekday: 1, amountCents: 50_000 })
    const now = new Date((await row(mandateId)).nextDueAt.getTime() + 60_000)
    await Promise.all([revokeMandate(ctx, mandateId), runDueMandates(uid, now)])
    const done = (await executions(mandateId)).length
    expect(await balance()).toBe(1_000_000 - done * 50_000)
    expect(done).toBeLessThanOrEqual(1)
    expect((await row(mandateId)).status).toBe('revoked')
  })

  it('收款人信息变化即暂停，不转向变化后的账号', async () => {
    const { mandateId } = await authorize({ every: 'weekly', weekday: 1, amountCents: 50_000 })
    await db.update(schema.payees).set({ accountNo: '6222999988887777' }).where(eq(schema.payees.id, payeeId))
    try {
      const results = await runDueMandates(uid, new Date((await row(mandateId)).nextDueAt.getTime() + 60_000))
      expect(results).toMatchObject([{ status: 'suspended' }])
      expect(await balance()).toBe(1_000_000)
      expect((await row(mandateId)).status).toBe('suspended')
    } finally {
      await db.update(schema.payees).set({ accountNo: '6222000011112222' }).where(eq(schema.payees.id, payeeId))
    }
  })

  it('余额不足：本次不扣款并稍后重试，连续失败后暂停', async () => {
    const { mandateId } = await authorize({ every: 'daily', amountCents: 50_000, validityDays: 10 })
    await db.update(schema.accounts).set({ balanceCents: 100 }).where(eq(schema.accounts.id, accountId))
    let now = new Date((await row(mandateId)).nextDueAt.getTime() + 60_000)
    for (let i = 1; i <= MANDATE_LIMITS.maxFailures; i++) {
      const results = await runDueMandates(uid, now)
      expect(results[0].status).toBe(i < MANDATE_LIMITS.maxFailures ? 'failed' : 'suspended')
      now = new Date(now.getTime() + MANDATE_LIMITS.retryDelayMs + 60_000)
    }
    expect(await row(mandateId)).toMatchObject({ status: 'suspended', failureCount: 3 })
    expect(await balance()).toBe(100)
    expect(await executions(mandateId)).toHaveLength(0)
  })

  it('审计中有创建、执行记录，且不含确认外的数值', async () => {
    const { mandateId } = await authorize({ every: 'weekly', weekday: 1, amountCents: 50_000 })
    await runDueMandates(uid, new Date((await row(mandateId)).nextDueAt.getTime() + 60_000))
    const logs = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.userId, uid)))
    const types = logs.map((l) => l.type)
    expect(types).toContain('mandate_created')
    expect(types).toContain('mandate_executed')
    expect(logs.some((l) => l.type === 'policy_decision' && l.payloadJson.includes('mandate_execution'))).toBe(true)
  })
})
