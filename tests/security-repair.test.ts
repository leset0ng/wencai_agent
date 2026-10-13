import { setTxPassword } from '#/server/auth/tx-password'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { auth, db, schema } from '#/server/db/client'
import { confirmPending } from './helpers/card-confirmation'
import { runBankTool } from '#/server/tools/runner'
import { transferBetweenAccounts } from '#/server/tools/payments'
import { commitCardChange, commitPurchase, commitRedemption, issueToken, previewCardChange } from '#/server/tools/bank-extended'
import { applyCard, adjustCreditLimit } from '#/server/tools/cards'
import { changeCreditLimit, creditSpend, ownProfile } from '#/server/cards/service'
import { rollbackInvestment } from '#/server/payments/investment-rollback'
import { resolveTool } from '#/server/tools/bank'
import { requestStepUpCode, verifyStrongStepUp } from '#/server/auth/step-up'
import { Route as securityRoute } from '#/routes/api/security'
import { verifyTxPassword } from '#/server/auth/tx-password'
import { hashParams } from '#/server/confirm/integrity'

const { session } = vi.hoisted(() => ({ session: vi.fn() }))
vi.mock('#/server/session', () => ({ requireSession: session }))
const uid = 'repair_security', ctx = { userId: uid, sessionId: 'repair-security', channel: 'web' as const }
const source = 'repair_source', target = 'repair_target', cardId = 'repair_card', product = 'repair_product'
const confirm = (id: string, stepUp?: Parameters<typeof confirmPending>[0]['stepUp']) => confirmPending({ ctx, actionId: id, resolveTool, stepUp })
async function sms(scope: string) {
  let code = ''
  const challenge = await requestStepUpCode(uid, scope, async (_phone, value) => { code = value })
  return { method: 'sms' as const, challengeId: challenge.challengeId, code }
}
const balance = async (id = source) => (await db.select().from(schema.accounts).where(eq(schema.accounts.id, id)))[0].balanceCents
beforeAll(async () => {
  await db.insert(schema.users).values({ id: uid, name: '修复回归', riskRating: 'R5', riskAssessedAt: new Date().toISOString() })
  await db.insert(auth.baUser).values({ id: uid, name: '修复回归', email: `${uid}@test.local`, emailVerified: true, phoneNumber: '13900009951', phoneNumberVerified: true, createdAt: new Date(), updatedAt: new Date() })
  await db.insert(schema.accounts).values([{ id: source, userId: uid, name: '付款账户', balanceCents: 200_000 }, { id: target, userId: uid, name: '收款账户', balanceCents: 0 }])
  await db.insert(schema.cards).values({ id: cardId, userId: uid, accountId: source, last4: '7744', kind: 'debit', status: 'active', dailyLimitCents: 5_000_000 })
  await db.insert(schema.products).values({ id: product, name: '回归产品', riskRating: 'R1', minAmountCents: 100, expectedYield: .02, termDays: 0 })
  session.mockResolvedValue({ userId: uid, userName: '修复回归', sessionId: ctx.sessionId })
  // These scenarios start with an enrolled banking account.
  for (const id of [uid]) await setTxPassword(id, '983701')
})
beforeEach(async () => {
  await db.delete(schema.holdings).where(eq(schema.holdings.userId, uid))
  await db.delete(schema.transactions).where(inArray(schema.transactions.accountId, [source, target]))
  await db.delete(schema.pendingActions).where(eq(schema.pendingActions.userId, uid))
  await db.$client.execute({ sql: 'DELETE FROM bank_step_up_codes WHERE user_id = ?', args: [uid] }).catch(() => {})
  await db.update(schema.users).set({ failedAuthCount: 0, lockedUntil: null }).where(eq(schema.users.id, uid))
  await db.update(schema.accounts).set({ balanceCents: 200_000 }).where(eq(schema.accounts.id, source))
  await db.update(schema.accounts).set({ balanceCents: 0 }).where(eq(schema.accounts.id, target))
  await db.update(schema.cards).set({ status: 'active' }).where(eq(schema.cards.id, cardId))
})
afterAll(async () => {
  const created = await db.select().from(schema.cards).where(eq(schema.cards.userId, uid))
  if (created.length) await db.delete(schema.bankCardProfiles).where(inArray(schema.bankCardProfiles.cardId, created.map((c) => c.id)))
  const accounts = await db.select().from(schema.accounts).where(eq(schema.accounts.userId, uid))
  if (accounts.length) await db.delete(schema.transactions).where(inArray(schema.transactions.accountId, accounts.map((a) => a.id)))
  await db.delete(schema.transactions).where(inArray(schema.transactions.accountId, [source, target]))
  await db.delete(schema.bankCardProfiles).where(eq(schema.bankCardProfiles.cardId, cardId))
  await db.delete(schema.cards).where(eq(schema.cards.userId, uid))
  await db.delete(schema.holdings).where(eq(schema.holdings.userId, uid))
  await db.delete(schema.pendingActions).where(eq(schema.pendingActions.userId, uid))
  await db.delete(schema.confirmationTokens).where(eq(schema.confirmationTokens.userId, uid))
  await db.delete(schema.accounts).where(eq(schema.accounts.userId, uid))
  await db.delete(schema.products).where(eq(schema.products.id, product))
  await db.delete(auth.baAccount).where(eq(auth.baAccount.userId, uid))
  await db.delete(auth.baUser).where(eq(auth.baUser.id, uid))
  await db.delete(schema.users).where(eq(schema.users.id, uid))
})
describe('安全要求修复回归', () => {
  it('用户申请信用卡需确认；调额需强验证且不可低于待还款', async () => {
    const proposal = await runBankTool(applyCard, { kind: 'credit', remark: '旅行卡' }, ctx)
    if (proposal.status !== 'needs_confirmation') throw new Error(JSON.stringify(proposal))
    expect((await db.select().from(schema.cards).where(eq(schema.cards.userId, uid))).length).toBe(1)
    const result = await confirm(proposal.actionId)
    if (!result.ok) throw new Error(JSON.stringify(result))
    const card = result.output as { cardId: string }
    expect(await ownProfile(uid, card.cardId)).toMatchObject({ kind: 'credit', remark: '旅行卡', balanceCents: 0, creditLimitCents: 2_000_000 })
    await creditSpend(uid, card.cardId, 10_000, '旅行测试')
    await expect(changeCreditLimit(uid, card.cardId, 5000)).rejects.toThrow()
    const limit = await runBankTool(adjustCreditLimit, { cardId: card.cardId, creditLimit: 500 }, ctx)
    if (limit.status !== 'needs_confirmation') throw new Error(JSON.stringify(limit))
    expect(limit.level).toBe('red')
    expect(await confirm(limit.actionId)).toMatchObject({ code: 'step_up_required' })
    expect((await confirm(limit.actionId, await sms(`action:${limit.actionId}`))).ok).toBe(true)
    expect(await ownProfile(uid, card.cardId)).toMatchObject({ creditLimitCents: 50_000, outstandingCents: 10_000 })
  })
  it('并发赎回不超出本金，回退按原交易冲正且不能重复退款', async () => {
    const holdingId = 'repair_redeem_holding'
    await db.insert(schema.holdings).values({ id: holdingId, userId: uid, productId: product, principalCents: 100_000, redeemableAt: new Date(0).toISOString(), createdAt: new Date(0).toISOString() })
    const args = { holdingId, toAccountId: source, amountCents: 80_000 }
    const tokens = await Promise.all([issueToken(ctx, 'redemption', args, {}), issueToken(ctx, 'redemption', args, {})])
    const results = await Promise.allSettled(tokens.map((token) => commitRedemption.execute({ ...args, confirmationToken: token.confirmationToken }, ctx)))
    const done = results.filter((result) => result.status === 'fulfilled')
    expect(done).toHaveLength(1)
    expect(await balance()).toBe(280_000)
    expect((await db.select().from(schema.holdings).where(eq(schema.holdings.id, holdingId)))[0].principalCents).toBe(20_000)
    const output = done[0].value as { transactionId: string; balanceAfter: number }
    expect(output.balanceAfter).toBe(2800)
    await rollbackInvestment(uid, output.transactionId, holdingId, 'redemption')
    await rollbackInvestment(uid, output.transactionId, holdingId, 'redemption')
    expect(await balance()).toBe(200_000)
    expect((await db.select().from(schema.holdings).where(eq(schema.holdings.id, holdingId)))[0].principalCents).toBe(100_000)
  })
  it('两笔600元常规交易不会因累计超过旧阈值误要求双重验证', async () => {
    const input = { fromAccountId: source, toAccountId: target, amountCents: 60_000 }
    const proposals = await Promise.all([runBankTool(transferBetweenAccounts, input, ctx), runBankTool(transferBetweenAccounts, input, ctx)])
    if (proposals.some((p) => p.status !== 'needs_confirmation')) throw new Error(JSON.stringify(proposals))
    const result = await Promise.all(proposals.map((p) => confirm((p as { actionId: string }).actionId)))
    expect(result.every((r) => r.ok)).toBe(true)
    expect(await balance(target)).toBe(120_000)
  })
  it('扩展挂失也是红色，密码不能代替强验证，已挂失卡不可解锁', async () => {
    const preview = await previewCardChange.execute({ cardId, action: 'lost' }, ctx)
    const out = await runBankTool(commitCardChange, { cardId, action: 'lost', confirmationToken: preview.confirmationToken }, ctx)
    if (out.status !== 'needs_confirmation') throw new Error(JSON.stringify(out))
    expect(out.level).toBe('red')
    expect(await confirm(out.actionId)).toMatchObject({ code: 'step_up_required' })
    expect(await confirm(out.actionId, { method: 'password', password: '123456' })).toMatchObject({ code: 'step_up_failed' })
    expect((await confirm(out.actionId, await sms(`action:${out.actionId}`))).ok).toBe(true)
    const unlock = await previewCardChange.execute({ cardId, action: 'unlock' }, ctx)
    await expect(commitCardChange.execute({ cardId, action: 'unlock', confirmationToken: unlock.confirmationToken }, ctx)).rejects.toThrow('不可恢复')
  })
  it('并发申购在事务内条件扣款，不再出现负余额', async () => {
    await db.update(schema.accounts).set({ balanceCents: 100_000 }).where(eq(schema.accounts.id, source))
    const args = { fromAccountId: source, productId: product, amountCents: 80_000 }
    const tokens = await Promise.all([issueToken(ctx, 'purchase', args, {}), issueToken(ctx, 'purchase', args, {})])
    const results = await Promise.allSettled(tokens.map((token) => commitPurchase.execute({ ...args, confirmationToken: token.confirmationToken }, ctx)))
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(await balance()).toBe(20_000)
  })
  it('短信挑战绑定用户与动作，不能换动作、猜测无限重试或重复消费', async () => {
    const proof = await sms('action:exact')
    expect(await verifyStrongStepUp(uid, 'action:other', proof)).toBe(false)
    expect(await verifyStrongStepUp('other-user', 'action:exact', proof)).toBe(false)
    const outcomes = await Promise.all([verifyStrongStepUp(uid, 'action:exact', proof), verifyStrongStepUp(uid, 'action:exact', proof)])
    expect(outcomes.filter(Boolean)).toHaveLength(1)
  })
  it('短信错误最多五次，正确验证码也不能绕过过期/尝试次数上限', async () => {
    const proof = await sms('action:limited')
    for (let i = 0; i < 5; i++) expect(await verifyStrongStepUp(uid, 'action:limited', { ...proof, code: proof.code === '000000' ? '111111' : '000000' })).toBe(false)
    expect(await verifyStrongStepUp(uid, 'action:limited', proof)).toBe(false)
  })
  it('修改密码接口无验证直接拒绝，验证码不能用于不同的新密码', async () => {
    const handler = (securityRoute.options.server!.handlers as { POST: (ctx: { request: Request }) => Promise<Response> }).POST
    const request = (body: unknown) => handler({ request: new Request('http://localhost/api/security', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) })
    expect((await request({ action: 'set_tx_password', password: '123123' })).status).toBe(403)
    expect(await verifyTxPassword(uid, '123456')).toBe(false)
    const proof = await sms(`security:${hashParams({ action: 'set_tx_password', password: '123123' })}`)
    expect((await request({ action: 'set_tx_password', password: '456456', stepUp: proof })).status).toBe(403)
    expect((await request({ action: 'set_tx_password', password: '123123', stepUp: proof })).status).toBe(200)
    expect(await verifyTxPassword(uid, '123123')).toBe(true)
    expect((await request({ action: 'set_tx_password', password: '123123', stepUp: proof })).status).toBe(403)
  })
  it('过期短信即使验证码正确也无法验证', async () => {
    const proof = await sms('action:expired')
    await db.update(schema.bankStepUpCodes).set({ expiresAt: new Date(0) }).where(eq(schema.bankStepUpCodes.id, proof.challengeId))
    expect(await verifyStrongStepUp(uid, 'action:expired', proof)).toBe(false)
  })
})
