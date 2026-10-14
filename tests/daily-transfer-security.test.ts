import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { auth, db, schema } from '#/server/db/client'
import { ensureCardPasswordSchema, hashCardPassword } from '#/server/cards/password'
import { ensurePaymentsSchema } from '#/server/payments/migrate'
import { ensureSplitSchema } from '#/server/payments/splits'
import { settleTransfer } from '#/server/payments/service'
import { ensureAutomationSchema, runAutomaticTransfers } from '#/server/automation/service'
import { runBankTool } from '#/server/tools/runner'
import { transfer } from '#/server/tools/bank'
import { paySplit } from '#/server/tools/splits'
import { createSecureRequest, secureRequestInfo, submitSecureRequest } from '#/server/security/operation'
import { beginDemoBiometric } from '#/server/auth/demo-biometric'
import { requestStepUpCode } from '#/server/auth/step-up'
import { transferActivity } from '#/server/policy/transfer-activity'
import { transferVerification } from '#/server/security/verification-policy'

const uid = 'daily_payer', receiver = 'daily_receiver', accounts = ['daily_a', 'daily_b', 'daily_target']
const ctx = { userId: uid, sessionId: 'daily-security', channel: 'web' as const }
const payeeId = 'daily_payee', tasks = ['daily_task_a', 'daily_task_b']
async function clear() {
  await db.delete(schema.transactions).where(inArray(schema.transactions.accountId, accounts))
  await db.delete(schema.bankSecureRequests).where(eq(schema.bankSecureRequests.userId, uid))
  await db.delete(schema.pendingActions).where(eq(schema.pendingActions.userId, uid))
  await db.delete(schema.bankStepUpCodes).where(eq(schema.bankStepUpCodes.userId, uid))
  await db.delete(schema.bankTaskPermissions).where(inArray(schema.bankTaskPermissions.taskId, tasks))
  await db.delete(schema.bankTaskApprovals).where(inArray(schema.bankTaskApprovals.taskId, tasks))
  await db.delete(schema.scheduledTasks).where(eq(schema.scheduledTasks.userId, uid))
  await db.delete(schema.bankSplitRequests).where(eq(schema.bankSplitRequests.payerUserId, uid))
  await db.delete(schema.splits).where(eq(schema.splits.id, 'daily_split'))
}
beforeAll(async () => {
  await ensurePaymentsSchema(); await ensureCardPasswordSchema(); await ensureSplitSchema(); await ensureAutomationSchema()
  for (const [id, phone] of [[uid, '13912340901'], [receiver, '13912340902']]) {
    await db.insert(schema.users).values({ id, name: id })
    await db.insert(auth.baUser).values({ id, name: id, email: `${id}@test.local`, phoneNumber: phone, phoneNumberVerified: true })
  }
  await db.insert(schema.accounts).values(accounts.map((id, i) => ({ id, userId: i === 2 ? receiver : uid, name: id, balanceCents: 1_000_000 })))
  for (const [i, accountId] of accounts.slice(0, 2).entries()) {
    const id = `${accountId}_card`
    await db.insert(schema.cards).values({ id, accountId, userId: uid, kind: 'debit', last4: `990${i}`, status: 'active', dailyLimitCents: 5_000_000 })
    await db.insert(schema.bankCardPasswords).values({ cardId: id, userId: uid, passwordHash: hashCardPassword('246810'), version: 1 })
  }
  await db.insert(schema.payees).values({ id: payeeId, userId: uid, name: '累计测试收款人', bank: '工商银行', accountNo: '6222000099991111', createdAt: new Date(0) })
})
beforeEach(async () => {
  await clear()
  await db.update(schema.accounts).set({ balanceCents: 1_000_000 }).where(inArray(schema.accounts.id, accounts))
  await db.update(schema.users).set({ failedAuthCount: 0, lockedUntil: null }).where(eq(schema.users.id, uid))
})
afterAll(async () => {
  await clear()
  await db.delete(schema.bankCardPasswords).where(eq(schema.bankCardPasswords.userId, uid))
  await db.delete(schema.cards).where(eq(schema.cards.userId, uid))
  await db.delete(schema.payees).where(eq(schema.payees.id, payeeId))
  await db.delete(schema.accounts).where(inArray(schema.accounts.id, accounts))
  await db.delete(auth.baUser).where(inArray(auth.baUser.id, [uid, receiver]))
  await db.delete(schema.users).where(inArray(schema.users.id, [uid, receiver]))
})
async function outgoing(cents: number, accountId = accounts[0], at = new Date()) {
  await db.insert(schema.transactions).values({ id: `daily_${randomUUID()}`, accountId, amountCents: -cents, category: '转账', counterparty: '历史转出', occurredAt: at })
}
async function propose(amount: number, accountId = accounts[0]) {
  const result = await runBankTool(transfer, { fromAccountId: accountId, payeeId, amount }, ctx)
  if (result.status !== 'needs_confirmation') throw new Error(JSON.stringify(result))
  const request = await createSecureRequest(ctx, { purpose: 'confirm_action', actionId: result.actionId })
  return { ...result, request }
}
async function face(actionId: string) { return { method: 'face' as const, ...await beginDemoBiometric(uid, `action:${actionId}`, 'face') } }

describe('日累计分级与最终执行验证闭环', () => {
  it('AA 基础红色不能只用卡密码执行，独立页面提示追加验证，短信强验证可完成', async () => {
    await db.insert(schema.splits).values({ id: 'daily_split', userId: receiver, title: 'AA测试', totalCents: 500, sharesJson: JSON.stringify([{ contactId: 'daily_contact', amountCents: 500, status: 'pending' }]), createdAt: new Date().toISOString() })
    await db.insert(schema.bankSplitRequests).values({ id: 'daily_aa', splitId: 'daily_split', contactId: 'daily_contact', requesterUserId: receiver, payerUserId: uid, targetAccountId: accounts[2], amountCents: 500, status: 'pending' })
    const result = await runBankTool(paySplit, { requestId: 'daily_aa', fromCardQuery: '9900' }, ctx)
    if (result.status !== 'needs_confirmation') throw new Error(JSON.stringify(result))
    expect(result.level).toBe('red')
    const request = await createSecureRequest(ctx, { purpose: 'confirm_action', actionId: result.actionId })
    expect(await secureRequestInfo(ctx, request.id)).toMatchObject({ strongRequired: true, singleChoice: false, dualRequired: false })
    expect(await submitSecureRequest(ctx, request.id, { password: '246810' })).toMatchObject({ ok: false, code: 'step_up_required' })
    expect((await db.select().from(schema.bankSplitRequests).where(eq(schema.bankSplitRequests.id, 'daily_aa')))[0].status).toBe('pending')
    let code = ''
    const sms = await requestStepUpCode(uid, `action:${result.actionId}`, async (_phone, value) => { code = value })
    expect(await submitSecureRequest(ctx, request.id, { password: '246810', stepUp: { method: 'sms', challengeId: sms.challengeId, code } })).toEqual({ ok: true })
    expect((await db.select().from(schema.bankSplitRequests).where(eq(schema.bankSplitRequests.id, 'daily_aa')))[0].status).toBe('paid')
  })

  it.each([[200, 'yellow', false], [200.01, 'red', true], [300, 'red', true]] as const)('今日跨卡转出800元，再转%s元：%s且强验证=%s', async (amount, level, strongRequired) => {
    await outgoing(80_000, accounts[1])
    const result = await propose(amount)
    expect(result.level).toBe(level)
    expect(await secureRequestInfo(ctx, result.request.id)).toMatchObject({ strongRequired, dualRequired: false })
    const attempt = await submitSecureRequest(ctx, result.request.id, { password: '246810' })
    if (strongRequired) {
      expect(attempt).toMatchObject({ code: 'step_up_required' })
      expect(await submitSecureRequest(ctx, result.request.id, { password: '246810', stepUp: await face(result.actionId) })).toEqual({ ok: true })
    } else expect(attempt).toEqual({ ok: true })
  })

  it('黄单生成后累计变化，安全页面与最终确认重新判定；旧密码验证不能放行', async () => {
    const result = await propose(300)
    expect(result.level).toBe('yellow')
    await outgoing(80_000, accounts[1])
    expect(await secureRequestInfo(ctx, result.request.id)).toMatchObject({ strongRequired: true, singleChoice: false })
    expect(await submitSecureRequest(ctx, result.request.id, { password: '246810' })).toMatchObject({ code: 'step_up_required' })
    expect((await db.select().from(schema.pendingActions).where(eq(schema.pendingActions.id, result.actionId)))[0]).toMatchObject({ level: 'red', status: 'pending' })
    expect(await submitSecureRequest(ctx, result.request.id, { password: '246810', stepUp: await face(result.actionId) })).toEqual({ ok: true })
  })

  it('两笔不同付款卡并发确认，仅未跨累计线的一笔可用密码执行，另一笔补验证后才能执行', async () => {
    await outgoing(80_000)
    const one = await propose(150), two = await propose(150, accounts[1])
    const results = await Promise.all([one, two].map((p) => submitSecureRequest(ctx, p.request.id, { password: '246810' })))
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.filter((r) => !r.ok && 'code' in r && r.code === 'step_up_required')).toHaveLength(1)
    expect((await transferActivity(uid, new Date())).dailyOutgoingCents).toBe(95_000)
    const retry = results[0].ok ? two : one
    expect(await submitSecureRequest(ctx, retry.request.id, { password: '246810', stepUp: await face(retry.actionId) })).toEqual({ ok: true })
    expect((await transferActivity(uid, new Date())).dailyOutgoingCents).toBe(110_000)
  })

  it('扣款事务复核跨账户累计，两份过期的黄色授权并发结算不能共同越线', async () => {
    await outgoing(80_000)
    const results = await Promise.allSettled(accounts.slice(0, 2).map((fromAccountId) => settleTransfer({ fromAccountId, payeeId, amountCents: 15_000 }, { ...ctx, authorization: { level: 'yellow', actionId: 'stale-yellow' } })))
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const failure = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(String(failure.reason)).toContain('累计转账超过 1000')
    expect((await transferActivity(uid, new Date())).dailyOutgoingCents).toBe(95_000)
  })

  it('定时执行逐笔重读累计，黄色授权跨线后等待红色确认，不自动扣款', async () => {
    const now = new Date()
    await outgoing(80_000, accounts[0], now)
    for (const [i, id] of tasks.entries()) {
      await db.insert(schema.scheduledTasks).values({ id, userId: uid, kind: 'transfer', status: 'pending', dueAt: now.toISOString(), payloadJson: JSON.stringify({ fromAccountId: accounts[i], payeeId, amountCents: 15_000 }), createdAt: now.toISOString() })
      await db.insert(schema.bankTaskPermissions).values({ taskId: id, level: 'yellow' })
    }
    await runAutomaticTransfers(uid, now)
    const states = await db.select().from(schema.scheduledTasks).where(eq(schema.scheduledTasks.userId, uid))
    expect(states.map((r) => r.status).sort()).toEqual(['awaiting_confirmation', 'succeeded'])
    const pending = (await db.select().from(schema.pendingActions).where(eq(schema.pendingActions.userId, uid)))[0]
    expect(pending.level).toBe('red')
    const request = await createSecureRequest(ctx, { purpose: 'confirm_action', actionId: pending.id })
    expect(await submitSecureRequest(ctx, request.id, { password: '246810' })).toMatchObject({ code: 'step_up_required' })
    expect(await submitSecureRequest(ctx, request.id, { password: '246810', stepUp: await face(pending.id) })).toEqual({ ok: true })
    expect((await db.select().from(schema.scheduledTasks).where(eq(schema.scheduledTasks.userId, uid))).every((r) => r.status === 'succeeded')).toBe(true)
  })

  it('UTC+8自然日累计排除前一天、未来流水、入账以及其他用户', async () => {
    const now = new Date('2026-10-14T00:05:00+08:00')
    await outgoing(99_999, accounts[0], new Date('2026-10-13T23:59:59+08:00'))
    await outgoing(80_000, accounts[1], new Date('2026-10-14T00:00:00+08:00'))
    await outgoing(99_999, accounts[0], new Date('2026-10-14T00:06:00+08:00'))
    await outgoing(99_999, accounts[2], now)
    await db.insert(schema.transactions).values({ id: 'daily_incoming', accountId: accounts[0], amountCents: 50_000, category: '转账', counterparty: '入账', occurredAt: now })
    expect(await transferActivity(uid, now)).toMatchObject({ dailyOutgoingCents: 80_000, recentTransferCount: 2 })
  })

  it('最终红色等级与双重验证独立，单笔规则不能覆盖AA基础风险或累计风险', () => {
    expect(transferVerification('pay_split_request', { amountCents: 500 }, {}, 'red')).toMatchObject({ strongRequired: true, dualRequired: false })
    expect(transferVerification('transfer', { amount: 300 }, {}, 'red')).toMatchObject({ strongRequired: true, dualRequired: false })
    expect(transferVerification('transfer', { amount: 3001 }, {}, 'red')).toMatchObject({ strongRequired: true, dualRequired: true })
  })
})
