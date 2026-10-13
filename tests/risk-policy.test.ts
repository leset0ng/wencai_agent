import { setTxPassword } from '#/server/auth/tx-password'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { auth, db, schema } from '#/server/db/client'
import type { AgentContext } from '#/server/agent/context'
import { beginDemoBiometric } from '#/server/auth/demo-biometric'
import { requestStepUpCode } from '#/server/auth/step-up'
import { confirmPending } from './helpers/card-confirmation'
import { collectFacts } from '#/server/policy/facts'
import { ensurePaymentsSchema } from '#/server/payments/migrate'
import { paymentAccounts, settleTransfer } from '#/server/payments/service'
import { ensureSplitSchema } from '#/server/payments/splits'
import { ensureAutomationSchema, runAutomaticTransfers } from '#/server/automation/service'
import { createMandate, ensureMandateSchema, planMandate, runDueMandates } from '#/server/automation/mandates'
import { addSuspectedRiskFlag, ensureRiskSchema, readAccountRiskFlag, reviewAccountRiskFlag } from '#/server/risk/accounts'
import { resolveTool, transfer } from '#/server/tools/bank'
import { transferBetweenCards } from '#/server/tools/cards'
import { transferBetweenAccounts } from '#/server/tools/payments'
import { paySplit } from '#/server/tools/splits'
import { runBankTool } from '#/server/tools/runner'

const payer = 'risk_policy_payer', recipient = 'risk_policy_recipient'
const source = 'risk_policy_source', destination = 'risk_policy_destination', ownDestination = 'risk_policy_own'
const payeeId = 'risk_policy_payee', legacyPayeeId = 'risk_policy_legacy'
const sourceCard = 'risk_policy_source_card', ownCard = 'risk_policy_own_card'
const splitId = 'risk_policy_split', requestId = 'risk_policy_request', taskId = 'risk_policy_schedule'
const userIds = [payer, recipient], accountIds = [source, destination, ownDestination]
const now = new Date('2026-10-13T04:00:00.000Z') // 北京时间中午，隔离夜间风险规则。
const ctx: AgentContext = { userId: payer, sessionId: 'risk-policy-regression', channel: 'web' }
const features = { ownerAgeDays: 2, incomingCount24h: 9, incomingCents24h: 900_000, distinctPayers24h: 8, outgoingCents24h: 850_000, rapidOutflowRatio: .94 }
let recipientAccountNo = ''

const balance = async (id = source) => (await db.select().from(schema.accounts).where(eq(schema.accounts.id, id)))[0].balanceCents
const pending = async (id: string) => (await db.select().from(schema.pendingActions).where(eq(schema.pendingActions.id, id)))[0]
const confirm = (actionId: string, stepUp?: Parameters<typeof confirmPending>[0]['stepUp']) => confirmPending({ ctx, actionId, stepUp, resolveTool })
async function propose(amount = 5) {
  const out = await runBankTool(transfer, { fromAccountId: source, payeeId, amount }, ctx)
  if (out.status !== 'needs_confirmation') throw new Error(JSON.stringify(out))
  return out
}
async function flag(accountId = destination) {
  await addSuspectedRiskFlag(accountId, features, ['distinct_payers', 'rapid_outflow'], undefined, { now })
  const row = await readAccountRiskFlag(accountId)
  if (!row) throw new Error('风险标记未保存')
  return row
}
async function confirmFlag(accountId = destination) {
  const row = await readAccountRiskFlag(accountId) ?? await flag(accountId)
  return reviewAccountRiskFlag({ accountId, expectedRevision: row.revision, decision: 'confirmed', reviewer: 'regression-reviewer' }, ctx)
}
async function sms(actionId: string) {
  let code = ''
  const proof = await requestStepUpCode(payer, `action:${actionId}`, async (_phone, value) => { code = value })
  return { method: 'sms' as const, challengeId: proof.challengeId, code }
}

beforeAll(async () => {
  await ensurePaymentsSchema()
  await ensureAutomationSchema()
  await ensureMandateSchema()
  await ensureSplitSchema()
  await ensureRiskSchema()
  await db.insert(schema.users).values([{ id: payer, name: '风控付款人' }, { id: recipient, name: '风控收款人' }])
  await db.insert(auth.baUser).values(userIds.map((id, i) => ({ id, name: i ? '风控收款人' : '风控付款人', email: `${id}@test.local`, emailVerified: true, phoneNumber: `1390000760${i}`, phoneNumberVerified: true, createdAt: new Date('2026-01-01'), updatedAt: new Date() })))
  await db.insert(schema.accounts).values([
    { id: source, userId: payer, name: '付款储蓄卡', balanceCents: 1_000_000 },
    { id: destination, userId: recipient, name: '收款储蓄卡', balanceCents: 0 },
    { id: ownDestination, userId: payer, name: '本人备用卡', balanceCents: 0 },
  ])
  await db.insert(schema.cards).values([
    { id: sourceCard, userId: payer, accountId: source, kind: 'debit', last4: '7601', status: 'active', dailyLimitCents: 5_000_000 },
    { id: ownCard, userId: payer, accountId: ownDestination, kind: 'debit', last4: '7602', status: 'active', dailyLimitCents: 5_000_000 },
  ])
  recipientAccountNo = (await paymentAccounts(recipient))[0].accountNo
  await paymentAccounts(payer)
  await db.insert(schema.payees).values([
    { id: payeeId, userId: payer, name: '风控收款人', accountNo: recipientAccountNo, bank: '文财银行', createdAt: new Date('2026-01-01') },
    // 旧收款记录可能只有账号，没有 bankPayeeLinks；风险查询仍须找到同一银行账户。
    { id: legacyPayeeId, userId: payer, name: '风控收款人', accountNo: recipientAccountNo, bank: '旧银行记录', createdAt: new Date('2026-01-01') },
  ])
  await db.insert(schema.bankPayeeLinks).values({ payeeId, userId: payer, targetAccountId: destination })
  // These scenarios start with an enrolled banking account.
  for (const id of userIds) await setTxPassword(id, '983701')
})

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now })
  await db.delete(schema.bankRiskFlags).where(inArray(schema.bankRiskFlags.accountId, accountIds))
  await db.delete(schema.pendingActions).where(inArray(schema.pendingActions.userId, userIds))
  await db.delete(schema.transactions).where(inArray(schema.transactions.accountId, accountIds))
  await db.delete(schema.bankTaskApprovals).where(eq(schema.bankTaskApprovals.taskId, taskId))
  await db.delete(schema.bankTaskPermissions).where(eq(schema.bankTaskPermissions.taskId, taskId))
  await db.delete(schema.scheduledTasks).where(eq(schema.scheduledTasks.id, taskId))
  const mandates = await db.select().from(schema.bankStandingMandates).where(eq(schema.bankStandingMandates.userId, payer))
  if (mandates.length) await db.delete(schema.bankMandateExecutions).where(inArray(schema.bankMandateExecutions.mandateId, mandates.map((m) => m.id)))
  await db.delete(schema.bankStandingMandates).where(eq(schema.bankStandingMandates.userId, payer))
  await db.delete(schema.bankSplitRequests).where(eq(schema.bankSplitRequests.id, requestId))
  await db.delete(schema.splits).where(eq(schema.splits.id, splitId))
  await db.delete(schema.bankStepUpCodes).where(eq(schema.bankStepUpCodes.userId, payer))
  await db.update(schema.users).set({ failedAuthCount: 0, lockedUntil: null }).where(eq(schema.users.id, payer))
  for (const id of accountIds) await db.update(schema.accounts).set({ balanceCents: id === source ? 1_000_000 : 0 }).where(eq(schema.accounts.id, id))
})
afterEach(() => vi.useRealTimers())

afterAll(async () => {
  await db.delete(schema.bankSplitRequests).where(eq(schema.bankSplitRequests.id, requestId))
  await db.delete(schema.splits).where(eq(schema.splits.id, splitId))
  await db.delete(schema.bankTaskApprovals).where(eq(schema.bankTaskApprovals.taskId, taskId))
  await db.delete(schema.bankTaskPermissions).where(eq(schema.bankTaskPermissions.taskId, taskId))
  await db.delete(schema.scheduledTasks).where(eq(schema.scheduledTasks.id, taskId))
  const mandates = await db.select().from(schema.bankStandingMandates).where(eq(schema.bankStandingMandates.userId, payer))
  if (mandates.length) await db.delete(schema.bankMandateExecutions).where(inArray(schema.bankMandateExecutions.mandateId, mandates.map((m) => m.id)))
  await db.delete(schema.bankStandingMandates).where(eq(schema.bankStandingMandates.userId, payer))
  await db.delete(schema.bankRiskFlags).where(inArray(schema.bankRiskFlags.accountId, accountIds))
  await db.delete(schema.pendingActions).where(inArray(schema.pendingActions.userId, userIds))
  await db.delete(schema.transactions).where(inArray(schema.transactions.accountId, accountIds))
  await db.delete(schema.bankStepUpCodes).where(eq(schema.bankStepUpCodes.userId, payer))
  await db.delete(schema.bankPayeeLinks).where(eq(schema.bankPayeeLinks.userId, payer))
  await db.delete(schema.payees).where(eq(schema.payees.userId, payer))
  await db.delete(schema.bankCardProfiles).where(inArray(schema.bankCardProfiles.cardId, [sourceCard, ownCard]))
  await db.delete(schema.cards).where(eq(schema.cards.userId, payer))
  await db.delete(schema.accounts).where(inArray(schema.accounts.id, accountIds))
  await db.delete(auth.baUser).where(inArray(auth.baUser.id, userIds))
  await db.delete(schema.users).where(inArray(schema.users.id, userIds))
})

describe('收款账户风险标记贯穿策略与结算', () => {
  it('老收款人原为黄色；AI 标记只升红色，人工确认后拒绝且没有扣款', async () => {
    expect((await propose()).level).toBe('yellow')
    await flag()
    const suspicious = await propose()
    expect(suspicious.level).toBe('red')
    expect(suspicious.reasons.join('')).toContain('核实')
    await confirmFlag()
    const rejected = await runBankTool(transfer, { fromAccountId: source, payeeId, amount: 5 }, ctx)
    expect(rejected.status).toBe('denied')
    expect(await balance()).toBe(1_000_000)
    expect(await balance(destination)).toBe(0)
  })

  it('已发出的黄色确认单在新增标记后必须升级并验证，不能提前消费或扣款', async () => {
    const proposal = await propose()
    await flag()
    expect(await confirm(proposal.actionId)).toMatchObject({ ok: false, code: 'step_up_required', requiredLevel: 'red' })
    expect(await pending(proposal.actionId)).toMatchObject({ status: 'pending', level: 'red' })
    expect(await balance()).toBe(1_000_000)
    expect((await confirm(proposal.actionId, { method: 'face', ...await beginDemoBiometric(payer, `action:${proposal.actionId}`, 'face') })).ok).toBe(true)
    expect(await balance()).toBe(999_500)
    expect(await balance(destination)).toBe(500)
  })

  it('原本已是红色且已取得验证码的确认单，也不能越过后来人工确认的高危账户', async () => {
    const proposal = await propose(3001)
    expect(proposal.level).toBe('red')
    const proof = await sms(proposal.actionId)
    await flag()
    await confirmFlag()
    expect(await confirm(proposal.actionId, proof)).toMatchObject({ ok: false, code: 'locked' })
    expect((await pending(proposal.actionId)).status).toBe('pending')
    expect(await balance()).toBe(1_000_000)
    expect(await balance(destination)).toBe(0)
  })

  it('旧红色确认单遇到新增风险时先展示新原因，不消费预先取得的验证码', async () => {
    const proposal = await propose(3001)
    const proof = await sms(proposal.actionId)
    await flag()
    const warning = await confirm(proposal.actionId, proof)
    expect(warning).toMatchObject({ ok: false, code: 'step_up_required', requiredLevel: 'red' })
    if (warning.ok) throw new Error('不能跳过新增核实提示')
    expect(warning.message).toContain('核实对方身份')
    expect(warning.reasons?.join('')).toContain('收款特征异常')
    expect((await db.select().from(schema.bankStepUpCodes).where(eq(schema.bankStepUpCodes.id, proof.challengeId)))[0].consumedAt).toBeNull()
    expect((await pending(proposal.actionId)).status).toBe('pending')
    expect(await balance(destination)).toBe(0)
    expect(await confirm(proposal.actionId, proof)).toMatchObject({ code: 'step_up_required' })
    expect((await confirm(proposal.actionId, { method: 'face', ...await beginDemoBiometric(payer, `action:${proposal.actionId}`, 'face') })).ok).toBe(true)
    expect(await balance(destination)).toBe(300_100)
  })

  it('结算事务校验具体标记版本；泛用红色授权、错账户和旧版本均不能扣款', async () => {
    const risk = await flag()
    const input = { fromAccountId: source, payeeId, amountCents: 500 }
    const red: AgentContext['authorization'] = { level: 'red', actionId: 'risk-regression-direct' }
    for (const authorization of [undefined, red, { ...red, payeeRisk: { accountId: ownDestination, revision: risk.revision } }, { ...red, payeeRisk: { accountId: destination, revision: risk.revision + 1 } }]) {
      await expect(settleTransfer(input, { ...ctx, authorization })).rejects.toThrow('风险')
    }
    expect(await balance()).toBe(1_000_000)
    const authorization = { ...red, payeeRisk: { accountId: destination, revision: risk.revision } }
    await settleTransfer(input, { ...ctx, authorization })
    expect(await balance(destination)).toBe(500)
    const reviewed = await confirmFlag()
    await expect(settleTransfer(input, { ...ctx, authorization: { ...red, payeeRisk: { accountId: destination, revision: reviewed.revision } } })).rejects.toThrow('高风险')
    expect(await balance()).toBe(999_500)
    expect(await balance(destination)).toBe(500)
  })

  it('本人互转、按卡备注互转、AA 请求都读取实际收款账户，AA 查询不得跨付款人', async () => {
    await flag(ownDestination)
    await confirmFlag(ownDestination)
    expect((await runBankTool(transferBetweenAccounts, { fromAccountId: source, toAccountId: ownDestination, amountCents: 500 }, ctx)).status).toBe('denied')
    expect((await runBankTool(transferBetweenCards, { fromCardQuery: '7601', toCardQuery: '7602', amountCents: 500 }, ctx)).status).toBe('denied')
    await flag()
    await confirmFlag()
    await db.insert(schema.splits).values({ id: splitId, userId: recipient, title: '风控 AA', totalCents: 1000, sharesJson: '[]', createdAt: now.toISOString() })
    await db.insert(schema.bankSplitRequests).values({ id: requestId, splitId, contactId: 'risk-policy-contact', requesterUserId: recipient, payerUserId: payer, targetAccountId: destination, amountCents: 500, status: 'pending' })
    expect((await runBankTool(paySplit, { requestId, fromCardQuery: '7601' }, ctx)).status).toBe('denied')
    expect(await collectFacts({ userId: payer, channel: 'web', splitRequestId: requestId })).toMatchObject({ payeeRiskFlag: 'confirmed', payeeRiskAccountId: destination })
    expect((await collectFacts({ userId: recipient, channel: 'web', splitRequestId: requestId })).payeeRiskFlag).toBeUndefined()
    expect(await balance()).toBe(1_000_000)
  })

  it('缺少收款关联的旧记录仍按账号定位标记，不能改用外部结算路径绕过', async () => {
    await flag()
    expect(await collectFacts({ userId: payer, channel: 'web', payeeId: legacyPayeeId })).toMatchObject({ payeeRiskFlag: 'suspected', payeeRiskAccountId: destination })
    expect((await collectFacts({ userId: recipient, channel: 'web', payeeId: legacyPayeeId })).payeeRiskFlag).toBeUndefined()
    await expect(settleTransfer({ fromAccountId: source, payeeId: legacyPayeeId, amountCents: 500 }, ctx)).rejects.toThrow('风险')
    expect(await balance()).toBe(1_000_000)
  })

  it('旧红色预约授权没有确认新增标记，worker 必须转人工核对而非自动扣款', async () => {
    await db.insert(schema.scheduledTasks).values({ id: taskId, userId: payer, kind: 'transfer', status: 'pending', dueAt: now.toISOString(), payloadJson: JSON.stringify({ fromAccountId: source, payeeId, amountCents: 500 }), createdAt: now.toISOString() })
    await db.insert(schema.bankTaskPermissions).values({ taskId, level: 'red' })
    await flag()
    await runAutomaticTransfers(payer, now)
    const task = (await db.select().from(schema.scheduledTasks).where(eq(schema.scheduledTasks.id, taskId)))[0]
    expect(task.status).toBe('awaiting_confirmation')
    const actionId = JSON.parse(task.resultJson!).actionId as string
    expect(await pending(actionId)).toMatchObject({ level: 'red', status: 'pending' })
    expect(await balance()).toBe(1_000_000)
    expect(await balance(destination)).toBe(0)
    expect(await confirm(actionId)).toMatchObject({ code: 'step_up_required' })
    expect((await confirm(actionId, { method: 'fingerprint', ...await beginDemoBiometric(payer, `action:${actionId}`, 'fingerprint') })).ok).toBe(true)
    expect(await balance(destination)).toBe(500)
    expect((await db.select().from(schema.scheduledTasks).where(eq(schema.scheduledTasks.id, taskId)))[0].status).toBe('succeeded')
  })

  it('已有红色定期授权不能自动接受新增风险，暂停时不消耗授权次数或金额', async () => {
    const plan = await planMandate(payer, { fromAccountId: source, payeeId, amountCents: 500, cadence: { every: 'daily', time: '09:00' } }, now)
    const created = await createMandate({ ...ctx, authorization: { level: 'red', actionId: 'risk-policy-old-mandate' } }, plan, now)
    await flag()
    const runs = await runDueMandates(payer, new Date(now.getTime() + 86_400_000))
    expect(runs).toEqual(expect.arrayContaining([expect.objectContaining({ mandateId: created.mandateId, status: 'suspended' })]))
    expect((await db.select().from(schema.bankStandingMandates).where(eq(schema.bankStandingMandates.id, created.mandateId)))[0]).toMatchObject({ status: 'suspended', executionsDone: 0, totalSpentCents: 0 })
    expect(await balance()).toBe(1_000_000)
    expect(await balance(destination)).toBe(0)
  })

  it('用户已核对的当前标记允许定期授权执行；标记版本变化后再次暂停', async () => {
    const risk = await flag()
    const plan = await planMandate(payer, { fromAccountId: source, payeeId, amountCents: 500, cadence: { every: 'daily', time: '09:00' } }, now)
    const created = await createMandate({ ...ctx, authorization: { level: 'red', actionId: 'risk-policy-acknowledged', payeeRisk: { accountId: destination, revision: risk.revision } } }, plan, now)
    await runDueMandates(payer, new Date(now.getTime() + 86_400_000))
    expect(await balance(destination)).toBe(500)
    await addSuspectedRiskFlag(destination, features, ['rapid_outflow'], 0, { now, snapshotHash: 'new-activity-revision' })
    await runDueMandates(payer, new Date(now.getTime() + 2 * 86_400_000))
    expect(await balance(destination)).toBe(500)
    expect((await db.select().from(schema.bankStandingMandates).where(eq(schema.bankStandingMandates.id, created.mandateId)))[0]).toMatchObject({ status: 'suspended', executionsDone: 1, totalSpentCents: 500 })
  })
})
