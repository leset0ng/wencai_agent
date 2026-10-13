import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { auth, db, schema } from '#/server/db/client'
import { getDashboard } from '#/server/dashboard'
import { runBankTool } from '#/server/tools/runner'
import { applyCard, transferBetweenCards } from '#/server/tools/cards'
import { resolveTool } from '#/server/tools/bank'
import { confirmPending } from '#/server/confirm/pending'
import { createSecureRequest, submitSecureRequest, consumeSecureResult, cancelSecureRequest } from '#/server/security/operation'
import { ensureCardPasswordSchema, verifyCardPassword } from '#/server/cards/password'
import { requestStepUpCode } from '#/server/auth/step-up'
import { beginDemoBiometric, verifyDemoBiometric } from '#/server/auth/demo-biometric'
import { addSuspectedRiskFlag } from '#/server/risk/accounts'
import { secureRequestInfo } from '#/server/security/operation'
import { env } from '#/server/env'
import { transferBetweenAccounts } from '#/server/tools/payments'
import { interactionReceiptText, resolveInteractionCommand } from '#/server/agent/interaction-command'

const uid = 'per_card_customer', other = 'per_card_other'
const ctx = { userId: uid, sessionId: 'per-card-session', channel: 'web' as const }
async function clearCards() {
  const cards = await db.select().from(schema.cards).where(eq(schema.cards.userId, uid))
  if (cards.length) {
    await db.delete(schema.bankRiskFlags).where(inArray(schema.bankRiskFlags.accountId, cards.map((c) => c.accountId)))
    await db.delete(schema.transactions).where(inArray(schema.transactions.accountId, cards.map((c) => c.accountId)))
    await db.delete(schema.bankCardNumbers).where(inArray(schema.bankCardNumbers.cardId, cards.map((c) => c.id)))
    await db.delete(schema.bankCardProfiles).where(inArray(schema.bankCardProfiles.cardId, cards.map((c) => c.id)))
  }
  await db.delete(schema.bankCardPasswords).where(eq(schema.bankCardPasswords.userId, uid))
  await db.delete(schema.bankSecureRequests).where(eq(schema.bankSecureRequests.userId, uid))
  await db.delete(schema.pendingActions).where(eq(schema.pendingActions.userId, uid))
  await db.delete(schema.cards).where(eq(schema.cards.userId, uid))
  await db.delete(schema.accounts).where(eq(schema.accounts.userId, uid))
}
beforeAll(async () => {
  await ensureCardPasswordSchema()
  for (const id of [uid, other]) {
    await db.insert(schema.users).values({ id, name: id })
    await db.insert(auth.baUser).values({ id, name: id, email: `${id}@test.local`, phoneNumber: id === uid ? '13912340301' : '13912340302', phoneNumberVerified: true })
  }
})
beforeEach(async () => {
  await clearCards()
  await db.update(schema.users).set({ failedAuthCount: 0, lockedUntil: null }).where(eq(schema.users.id, uid))
  await db.delete(schema.bankStepUpCodes).where(eq(schema.bankStepUpCodes.userId, uid))
})
afterAll(async () => {
  await clearCards()
  await db.delete(schema.bankStepUpCodes).where(eq(schema.bankStepUpCodes.userId, uid))
  await db.delete(auth.baUser).where(inArray(auth.baUser.id, [uid, other]))
  await db.delete(schema.users).where(inArray(schema.users.id, [uid, other]))
})
async function proposeCard() {
  const result = await runBankTool(applyCard, { kind: 'debit', remark: '储蓄卡' }, ctx)
  if (result.status !== 'needs_confirmation') throw new Error(JSON.stringify(result))
  return result.actionId
}
async function issue(password = '246810') {
  const actionId = await proposeCard(), request = await createSecureRequest(ctx, { purpose: 'confirm_action', actionId })
  expect(await submitSecureRequest(ctx, request.id, { password })).toEqual({ ok: true })
  const result = await consumeSecureResult(ctx, request.id) as { output: { cardId: string; accountId: string; last4: string } }
  return result.output
}
describe('注册后无卡与独立安全页面协议', () => {
  it('消息核对不会执行交易，取消消息只能取消本人确认单且可幂等核对', async () => {
    const actionId = await proposeCard()
    await expect(resolveInteractionCommand({ ...ctx, userId: other }, { cancelActionId: actionId })).rejects.toThrow('不属于')
    expect(await resolveInteractionCommand(ctx, { verificationActionId: actionId })).toBe(actionId)
    expect(interactionReceiptText({ status: 'pending' })).toContain('验证通过前不会执行')
    expect(interactionReceiptText({ status: 'cancelled' })).toContain('已取消')
    expect(interactionReceiptText({ status: 'expired' })).toContain('重新办理')
    expect((await getDashboard(uid)).cards).toHaveLength(0)
    expect(await resolveInteractionCommand(ctx, { cancelActionId: actionId })).toBe(actionId)
    expect(await resolveInteractionCommand(ctx, { cancelActionId: actionId })).toBe(actionId)
    expect((await db.select().from(schema.pendingActions).where(eq(schema.pendingActions.id, actionId)))[0].status).toBe('cancelled')
    expect((await getDashboard(uid)).cards).toHaveLength(0)
    const completedAction = await proposeCard(), secure = await createSecureRequest(ctx, { purpose: 'confirm_action', actionId: completedAction })
    await submitSecureRequest(ctx, secure.id, { password: '246810' })
    expect(await resolveInteractionCommand(ctx, { cancelActionId: completedAction })).toBe(completedAction)
    expect((await getDashboard(uid)).cards).toHaveLength(1)
    expect((await db.select().from(schema.pendingActions).where(eq(schema.pendingActions.id, completedAction)))[0].status).toBe('consumed')
  })
  it('新注册用户可直接浏览首页，查询不自动发卡或要求密码', async () => {
    const dashboard = await getDashboard(uid)
    expect(dashboard.cards).toEqual([])
    expect(dashboard.accounts).toEqual([])
    expect(dashboard.availableBalance).toBe(0)
  })
  it('普通确认不能跳过新卡密码设置，取消安全页不发卡，取消后无法提交', async () => {
    const actionId = await proposeCard()
    expect(await confirmPending({ ctx, actionId, resolveTool })).toMatchObject({ ok: false, code: 'card_password_required' })
    const request = await createSecureRequest(ctx, { purpose: 'confirm_action', actionId })
    expect(await cancelSecureRequest(ctx, request.id)).toEqual({ cancelled: true })
    await expect(submitSecureRequest(ctx, request.id, { password: '246810' })).rejects.toThrow('已处理')
    expect((await getDashboard(uid)).cards).toHaveLength(0)
  })
  it('独立页面请求绑定用户及浏览器会话，不能越权获取结果', async () => {
    const card = await issue()
    const request = await createSecureRequest(ctx, { purpose: 'view_card', cardId: card.cardId })
    await submitSecureRequest(ctx, request.id, { password: '246810' })
    await expect(consumeSecureResult({ ...ctx, userId: other }, request.id)).rejects.toThrow('不属于')
    await expect(consumeSecureResult({ ...ctx, sessionId: 'different' }, request.id)).rejects.toThrow('不属于')
    expect(await consumeSecureResult(ctx, request.id)).toMatchObject({ number: expect.stringMatching(/^\d{16}$/) })
    await expect(consumeSecureResult(ctx, request.id)).rejects.toThrow('已使用')
  })
})
describe('每张银行卡密码独立与交易绑定', () => {
  it('独立资金账户没有银行卡时，常规交易仍可短信验证，但不能直接跳过验证', async () => {
    await db.insert(schema.accounts).values([{ id: 'per_card_unlinked_a', userId: uid, name: '独立资金A', balanceCents: 5000 }, { id: 'per_card_unlinked_b', userId: uid, name: '独立资金B', balanceCents: 0 }])
    const proposal = await runBankTool(transferBetweenAccounts, { fromAccountId: 'per_card_unlinked_a', toAccountId: 'per_card_unlinked_b', amountCents: 100 }, ctx)
    if (proposal.status !== 'needs_confirmation') throw new Error(JSON.stringify(proposal))
    expect(await confirmPending({ ctx, actionId: proposal.actionId, resolveTool })).toMatchObject({ code: 'card_password_required' })
    const request = await createSecureRequest(ctx, { purpose: 'confirm_action', actionId: proposal.actionId })
    expect(await secureRequestInfo(ctx, request.id)).toMatchObject({ card: null, passwordRequired: false, singleChoice: true })
    let code = ''
    const challenge = await requestStepUpCode(uid, `action:${proposal.actionId}`, async (_phone, value) => { code = value })
    expect(await submitSecureRequest(ctx, request.id, { method: 'sms', stepUp: { method: 'sms', challengeId: challenge.challengeId, code } })).toEqual({ ok: true })
    expect((await db.select().from(schema.accounts).where(eq(schema.accounts.id, 'per_card_unlinked_b')))[0].balanceCents).toBe(100)
  })
  it.each(['sms', 'fingerprint', 'face'] as const)('常规交易仅用 %s 即可，无需附加卡密码，回执不能重放', async (method) => {
    const a = await issue(), b = await issue()
    await db.update(schema.accounts).set({ balanceCents: 500_000 }).where(eq(schema.accounts.id, a.accountId))
    const proposal = await runBankTool(transferBetweenCards, { fromCardQuery: a.last4, toCardQuery: b.last4, amountCents: 300_000 }, ctx)
    if (proposal.status !== 'needs_confirmation') throw new Error(JSON.stringify(proposal))
    const request = await createSecureRequest(ctx, { purpose: 'confirm_action', actionId: proposal.actionId })
    expect(await secureRequestInfo(ctx, request.id)).toMatchObject({ singleChoice: true, dualRequired: false })
    let code = ''
    const stepUp = method === 'sms' ? { method, ...await requestStepUpCode(uid, `action:${proposal.actionId}`, async (_phone, value) => { code = value }), code } : { method, ...await beginDemoBiometric(uid, `action:${proposal.actionId}`, method) }
    expect(await submitSecureRequest(ctx, request.id, { method, stepUp })).toEqual({ ok: true })
    expect((await db.select().from(schema.accounts).where(eq(schema.accounts.id, a.accountId)))[0].balanceCents).toBe(200_000)
    await expect(submitSecureRequest(ctx, request.id, { method, stepUp })).rejects.toThrow('已处理')
  })
  it.each(['fingerprint', 'face'] as const)('超过3000元必须卡密码加 %s，短信及单一方式不能放行', async (method) => {
    const a = await issue(), b = await issue()
    await db.update(schema.accounts).set({ balanceCents: 500_000 }).where(eq(schema.accounts.id, a.accountId))
    const proposal = await runBankTool(transferBetweenCards, { fromCardQuery: a.last4, toCardQuery: b.last4, amountCents: 300_001 }, ctx)
    if (proposal.status !== 'needs_confirmation') throw new Error(JSON.stringify(proposal))
    const request = await createSecureRequest(ctx, { purpose: 'confirm_action', actionId: proposal.actionId })
    expect(await secureRequestInfo(ctx, request.id)).toMatchObject({ singleChoice: false, dualRequired: true })
    const stepUp = { method, ...await beginDemoBiometric(uid, `action:${proposal.actionId}`, method) }
    await expect(submitSecureRequest(ctx, request.id, { method, stepUp })).rejects.toThrow('必须先验证')
    expect(await submitSecureRequest(ctx, request.id, { password: '246810' })).toMatchObject({ ok: false, code: 'step_up_required' })
    expect(await submitSecureRequest(ctx, request.id, { password: '246810', stepUp: { method: 'sms', challengeId: 'fake', code: '123456' } })).toMatchObject({ ok: false, code: 'step_up_required' })
    expect((await db.select().from(schema.accounts).where(eq(schema.accounts.id, a.accountId)))[0].balanceCents).toBe(500_000)
    expect(await submitSecureRequest(ctx, request.id, { password: '246810', stepUp })).toEqual({ ok: true })
    expect((await db.select().from(schema.accounts).where(eq(schema.accounts.id, b.accountId)))[0].balanceCents).toBe(300_001)
  })
  it('小额交易在收款账户被标记后升级为双重验证，不能用原来的单方式放行', async () => {
    const a = await issue(), b = await issue()
    await db.update(schema.accounts).set({ balanceCents: 5000 }).where(eq(schema.accounts.id, a.accountId))
    const proposal = await runBankTool(transferBetweenCards, { fromCardQuery: a.last4, toCardQuery: b.last4, amountCents: 100 }, ctx)
    if (proposal.status !== 'needs_confirmation') throw new Error(JSON.stringify(proposal))
    const request = await createSecureRequest(ctx, { purpose: 'confirm_action', actionId: proposal.actionId })
    await addSuspectedRiskFlag(b.accountId, { ownerAgeDays: 1, incomingCount24h: 9, incomingCents24h: 900_000, distinctPayers24h: 8, outgoingCents24h: 850_000, rapidOutflowRatio: .94 }, ['distinct_payers'])
    expect(await secureRequestInfo(ctx, request.id)).toMatchObject({ dualRequired: true })
    const stepUp = { method: 'face' as const, ...await beginDemoBiometric(uid, `action:${proposal.actionId}`, 'face') }
    await expect(submitSecureRequest(ctx, request.id, { method: 'face', stepUp })).rejects.toThrow('必须先验证')
    expect(await submitSecureRequest(ctx, request.id, { password: '246810', stepUp })).toMatchObject({ code: 'step_up_required' }) // first acknowledge newly added warning
    expect(await submitSecureRequest(ctx, request.id, { password: '246810', stepUp })).toEqual({ ok: true })
  })
  it('演示识别凭据绑定用户、动作、方式且仅能使用一次', async () => {
    const proof = await beginDemoBiometric(uid, 'action:demo-scope', 'face')
    expect(await verifyDemoBiometric(other, 'action:demo-scope', 'face', proof.challengeId)).toBe(false)
    expect(await verifyDemoBiometric(uid, 'action:other', 'face', proof.challengeId)).toBe(false)
    expect(await verifyDemoBiometric(uid, 'action:demo-scope', 'fingerprint', proof.challengeId)).toBe(false)
    expect(await verifyDemoBiometric(uid, 'action:demo-scope', 'face', proof.challengeId)).toBe(true)
    expect(await verifyDemoBiometric(uid, 'action:demo-scope', 'face', proof.challengeId)).toBe(false)
  })
  it('关闭演示模式后不能签发或使用指纹、人脸模拟凭据', async () => {
    const proof = await beginDemoBiometric(uid, 'action:demo-disabled', 'face'), original = env.AUTH_DEMO_MODE
    try {
      env.AUTH_DEMO_MODE = false
      await expect(beginDemoBiometric(uid, 'action:demo-disabled', 'face')).rejects.toThrow('未开启演示')
      expect(await verifyDemoBiometric(uid, 'action:demo-disabled', 'face', proof.challengeId)).toBe(false)
    } finally { env.AUTH_DEMO_MODE = original }
  })
  it('两张卡密码互不通用，卡号查看只验证所选卡', async () => {
    const a = await issue('246810'), b = await issue('135790')
    await expect(verifyCardPassword(ctx, a.cardId, '246810')).resolves.toBe(1)
    await expect(verifyCardPassword(ctx, b.cardId, '246810')).rejects.toThrow('该银行卡交易密码错误')
    await expect(verifyCardPassword(ctx, b.cardId, '135790')).resolves.toBe(1)
    const stored = await db.select().from(schema.bankCardPasswords).where(eq(schema.bankCardPasswords.userId, uid))
    expect(new Set(stored.map((r) => r.passwordHash)).size).toBe(2)
    expect(JSON.stringify(stored)).not.toMatch(/246810|135790/)
  })
  it('改A卡密码需强验证，验证版本失效，B卡密码不变', async () => {
    const a = await issue('246810'), b = await issue('135790')
    const view = await createSecureRequest(ctx, { purpose: 'view_card', cardId: a.cardId })
    await submitSecureRequest(ctx, view.id, { password: '246810' })
    const reset = await createSecureRequest(ctx, { purpose: 'change_card_password', cardId: a.cardId })
    await expect(submitSecureRequest(ctx, reset.id, { password: '975310' })).rejects.toThrow('强验证')
    let code = ''
    const challenge = await requestStepUpCode(uid, `card-password:${reset.id}`, async (_phone, value) => { code = value })
    await submitSecureRequest(ctx, reset.id, { password: '975310', stepUp: { method: 'sms', challengeId: challenge.challengeId, code } })
    await expect(consumeSecureResult(ctx, view.id)).rejects.toThrow('安全状态已变化')
    await expect(verifyCardPassword(ctx, a.cardId, '246810')).rejects.toThrow('密码错误')
    await expect(verifyCardPassword(ctx, a.cardId, '975310')).resolves.toBe(2)
    await expect(verifyCardPassword(ctx, b.cardId, '135790')).resolves.toBe(1)
  })
  it('交易验证绑定付款卡和动作；其他用途凭据不能放行，成功后不能重放', async () => {
    const a = await issue('246810'), b = await issue('135790')
    await db.update(schema.accounts).set({ balanceCents: 5000 }).where(eq(schema.accounts.id, a.accountId))
    const proposal = await runBankTool(transferBetweenCards, { fromCardQuery: a.last4, toCardQuery: b.last4, amountCents: 100 }, ctx)
    if (proposal.status !== 'needs_confirmation') throw new Error(JSON.stringify(proposal))
    const view = await createSecureRequest(ctx, { purpose: 'view_card', cardId: a.cardId })
    await submitSecureRequest(ctx, view.id, { password: '246810' })
    expect(await confirmPending({ ctx, actionId: proposal.actionId, secureRequestId: view.id, resolveTool })).toMatchObject({ code: 'card_password_required' })
    const request = await createSecureRequest(ctx, { purpose: 'confirm_action', actionId: proposal.actionId })
    await expect(submitSecureRequest(ctx, request.id, { password: '135790' })).rejects.toThrow('密码错误')
    expect((await db.select().from(schema.accounts).where(eq(schema.accounts.id, a.accountId)))[0].balanceCents).toBe(5000)
    const submitted = await submitSecureRequest(ctx, request.id, { password: '246810' })
    expect(submitted).toEqual({ ok: true })
    expect(await consumeSecureResult(ctx, request.id)).toMatchObject({ ok: true })
    await expect(submitSecureRequest(ctx, request.id, { password: '246810' })).rejects.toThrow('已处理')
    expect((await db.select().from(schema.accounts).where(eq(schema.accounts.id, a.accountId)))[0].balanceCents).toBe(4900)
    expect((await db.select().from(schema.accounts).where(eq(schema.accounts.id, b.accountId)))[0].balanceCents).toBe(100)
  })
  it('页面请求超时不能读取卡号，失败验证仍触发账户熔断', async () => {
    const a = await issue()
    const request = await createSecureRequest(ctx, { purpose: 'view_card', cardId: a.cardId })
    await submitSecureRequest(ctx, request.id, { password: '246810' })
    await db.update(schema.bankSecureRequests).set({ expiresAt: new Date(0) }).where(eq(schema.bankSecureRequests.id, request.id))
    await expect(consumeSecureResult(ctx, request.id)).rejects.toThrow('过期')
    expect(await cancelSecureRequest(ctx, request.id)).toEqual({ cancelled: true })
    for (let i = 0; i < 5; i++) await expect(verifyCardPassword(ctx, a.cardId, '000000')).rejects.toThrow()
    await expect(verifyCardPassword(ctx, a.cardId, '246810')).rejects.toThrow('临时锁定')
  })
})
