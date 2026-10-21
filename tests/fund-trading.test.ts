import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { auth, db, schema } from '#/server/db/client'
import { ensureFundData, syncFund } from '#/server/funds/store'
import { FixtureProvider } from '#/server/funds/fixture'
import { compensateFundOrder, confirmFundOrders, effectiveTradeDate, fundPortfolio, previewFundOrder, submitFundOrder, subscriptionShares } from '#/server/funds/trading'
import { ensureCardSchema } from '#/server/cards/service'
import { ensureCardNumberSchema } from '#/server/cards/numbers'
import { ensureCardPasswordSchema, hashCardPassword } from '#/server/cards/password'
import { beginDemoBiometric } from '#/server/auth/demo-biometric'
import { createSecureRequest, submitSecureRequest, consumeSecureResult } from '#/server/security/operation'
import { confirmPending } from '#/server/confirm/pending'
import { runBankTool } from '#/server/tools/runner'
import { resolveTool } from '#/server/tools/bank'
import { getWealthAdvice, AdviceInput } from '#/server/funds/advice'
import { computeProfile } from '#/server/profile/profile'
import { getDashboard } from '#/server/dashboard'
const userId = 'fund_test_user', otherId = 'fund_test_other', account = 'fund_test_account', card = 'fund_test_card', code = '110007'
const ctx = { userId, sessionId: 'fund-browser', channel: 'web' as const }
const now = new Date('2026-10-20T06:30:00Z'), tomorrow = new Date('2026-10-21T02:00:00Z')
const input = { code, fromAccountId: account, amountCents: 10000 }
let clock: string | undefined, clockMode: string | undefined
const balance = async () => (await db.select().from(schema.accounts).where(eq(schema.accounts.id, account)))[0].balanceCents
const orderContext = (actionId = 'fund-action') => ({ ...ctx, authorization: { level: 'red' as const, actionId } })
async function clear() {
  await db.delete(schema.bankFundPositions).where(inArray(schema.bankFundPositions.userId, [userId, otherId]))
  await db.delete(schema.bankFundOrders).where(inArray(schema.bankFundOrders.userId, [userId, otherId]))
  await db.delete(schema.transactions).where(eq(schema.transactions.accountId, account))
  await db.delete(schema.confirmationTokens).where(eq(schema.confirmationTokens.userId, userId))
  await db.delete(schema.pendingActions).where(eq(schema.pendingActions.userId, userId))
  await db.delete(schema.bankSecureRequests).where(eq(schema.bankSecureRequests.userId, userId))
  await db.delete(schema.bankStepUpCodes).where(eq(schema.bankStepUpCodes.userId, userId))
  await db.update(schema.accounts).set({ balanceCents: 2000000 }).where(eq(schema.accounts.id, account))
  await db.update(schema.users).set({ riskRating: 'R5', riskAssessedAt: '2026-10-01T00:00:00Z', lockedUntil: null }).where(eq(schema.users.id, userId))
  await db.update(schema.cards).set({ status: 'active', kind: 'debit', dailyLimitCents: 99999999 }).where(eq(schema.cards.id, card))
  await db.update(schema.bankFunds).set({ enabled: true, purchaseStatus: 'open', purchaseFeeBp: 15 }).where(eq(schema.bankFunds.code, code))
  await db.delete(schema.bankFundNavs).where(and(eq(schema.bankFundNavs.code, code), inArray(schema.bankFundNavs.navDate, ['2026-10-20', '2026-10-21', '2026-10-23', '2026-10-26'])))
}
async function nav(date: string, value: number, fetched = '2026-10-20T12:00:00Z') {
  await db.insert(schema.bankFundNavs).values({ code, navDate: date, unitNavE4: value, accNavE4: value, fetchedAt: fetched }).onConflictDoNothing()
}
beforeAll(async () => {
  await ensureFundData(); await ensureCardSchema(); await ensureCardNumberSchema(); await ensureCardPasswordSchema()
  clock = (await db.select().from(schema.settings).where(eq(schema.settings.key, 'clock')))[0]?.value
  clockMode = (await db.select().from(schema.settings).where(eq(schema.settings.key, 'clock_mode')))[0]?.value
  await db.insert(schema.settings).values({ key: 'clock', value: now.toISOString() }).onConflictDoUpdate({ target: schema.settings.key, set: { value: now.toISOString() } })
  await db.insert(schema.settings).values({ key: 'clock_mode', value: 'manual' }).onConflictDoUpdate({ target: schema.settings.key, set: { value: 'manual' } })
  await db.insert(schema.users).values([{ id: userId, name: '基金测试' }, { id: otherId, name: '其他用户' }])
  await db.insert(auth.baUser).values({ id: userId, name: '基金测试', email: 'fund@test.local', phoneNumber: '13900002222', phoneNumberVerified: true })
  await db.insert(schema.accounts).values({ id: account, userId, name: '基金测试账户', balanceCents: 2000000 })
  await db.insert(schema.cards).values({ id: card, userId, accountId: account, last4: '8991', kind: 'debit', status: 'active', dailyLimitCents: 99999999 })
  await db.insert(schema.bankCardProfiles).values({ cardId: card, remark: '基金测试卡' })
  await db.insert(schema.bankCardPasswords).values({ cardId: card, userId, passwordHash: hashCardPassword('246810') })
})
beforeEach(clear)
afterAll(async () => {
  await clear()
  for (const [key, value] of [['clock', clock], ['clock_mode', clockMode]]) {
    if (value) await db.update(schema.settings).set({ value }).where(eq(schema.settings.key, key!))
    else await db.delete(schema.settings).where(eq(schema.settings.key, key!))
  }
  await db.delete(schema.bankCardPasswords).where(eq(schema.bankCardPasswords.cardId, card))
  await db.delete(schema.bankCardNumbers).where(eq(schema.bankCardNumbers.cardId, card))
  await db.delete(schema.bankCardProfiles).where(eq(schema.bankCardProfiles.cardId, card))
  await db.delete(schema.cards).where(eq(schema.cards.id, card)); await db.delete(schema.accounts).where(eq(schema.accounts.id, account))
  await db.delete(auth.baUser).where(eq(auth.baUser.id, userId)); await db.delete(schema.users).where(inArray(schema.users.id, [userId, otherId]))
  await syncFund(code, new FixtureProvider(), tomorrow, true)
})
async function buy(actionId = 'fund-action', time = now) {
  const preview = await previewFundOrder(ctx, input, time)
  return submitFundOrder(orderContext(actionId), { ...input, confirmationToken: preview.confirmationToken }, time)
}
describe('unknown NAV fund orders and existing red confirmation chain', () => {
  it.each([
    ['2026-10-20T06:59:59Z', '2026-10-20'], ['2026-10-20T07:00:00Z', '2026-10-21'],
    ['2026-10-23T08:00:00Z', '2026-10-24'], ['2026-10-24T02:00:00Z', '2026-10-24'],
  ])('uses CST 15:00 cutoff %s -> %s without a calendar', (date, expected) => expect(effectiveTradeDate(new Date(date))).toBe(expected))
  it('calculates cents, fee and shares with integer arithmetic', () => {
    expect(subscriptionShares(10000, 15, 12345)).toEqual({ feeCents: 15, sharesE2: 8088 })
    expect(() => subscriptionShares(1.2, 0, 10000)).toThrow()
  })
  it('preview does not debit; commit requires red authorization', async () => {
    const preview = await previewFundOrder(ctx, input, now)
    expect(await balance()).toBe(2000000)
    await expect(submitFundOrder(ctx, { ...input, confirmationToken: preview.confirmationToken }, now)).rejects.toThrow('红色')
    expect(await balance()).toBe(2000000)
  })
  it('debits immediately, with no known-price shares; repeat calls cannot charge twice', async () => {
    const preview = await previewFundOrder(ctx, input, now), args = { ...input, confirmationToken: preview.confirmationToken }
    const orders = await Promise.all([submitFundOrder(orderContext(), args, now), submitFundOrder(orderContext(), args, now)])
    expect(orders[0].id).toBe(orders[1].id); expect(orders[0]).toMatchObject({ status: 'submitted', sharesE2: null, navDate: null })
    expect(await balance()).toBe(1990000)
    await expect(submitFundOrder(orderContext('different'), args, now)).rejects.toThrow('预览')
  })
  it('rejects changed parameters without consuming token or charging', async () => {
    const preview = await previewFundOrder(ctx, input, now)
    await expect(submitFundOrder(orderContext(), { ...input, amountCents: 20000, confirmationToken: preview.confirmationToken }, now)).rejects.toThrow('参数不匹配')
    expect(await balance()).toBe(2000000)
    expect((await submitFundOrder(orderContext(), { ...input, confirmationToken: preview.confirmationToken }, now)).status).toBe('submitted')
  })
  it('waits for a qualifying published NAV and T+1, then uses first eligible date, not latest', async () => {
    const order = await buy()
    expect(await confirmFundOrders(tomorrow)).not.toContain(order.id)
    await nav('2026-10-20', 12345); await nav('2026-10-21', 20000)
    expect(await confirmFundOrders(now)).not.toContain(order.id)
    expect(await confirmFundOrders(tomorrow)).toContain(order.id)
    expect((await fundPortfolio(userId, tomorrow)).orders[0]).toMatchObject({ status: 'confirmed', navDate: '2026-10-20', unitNavE4: 12345, sharesE2: 8088 })
    await confirmFundOrders(tomorrow)
    expect((await fundPortfolio(userId, tomorrow)).positions[0].sharesE2).toBe(8088)
  })
  it('rolls weekend orders to the first available NAV without a calendar', async () => {
    const friday = new Date('2026-10-23T08:00:00Z'), monday = new Date('2026-10-26T08:00:00Z'), tuesday = new Date('2026-10-27T02:00:00Z')
    await nav('2026-10-23', 12000, '2026-10-23T12:00:00Z')
    const order = await buy('weekend', friday)
    await nav('2026-10-26', 14000, '2026-10-26T12:00:00Z')
    expect(await confirmFundOrders(monday)).not.toContain(order.id)
    expect(await confirmFundOrders(tuesday)).toContain(order.id)
    expect((await fundPortfolio(userId, tuesday)).orders[0].navDate).toBe('2026-10-26')
  })
  it('settles historical simulation by published NAV date rather than the later snapshot collection timestamp', async () => {
    const historical = new Date('2026-10-12T06:30:00Z'), followingDay = new Date('2026-10-13T02:00:00Z')
    const order = await buy('historical-replay', historical)
    expect(await confirmFundOrders(historical)).not.toContain(order.id)
    expect(await confirmFundOrders(followingDay)).toContain(order.id)
    expect((await fundPortfolio(userId, followingDay)).orders[0]).toMatchObject({ status: 'confirmed', navDate: '2026-10-12' })
  })
  it.each(['risk', 'suspended', 'stale', 'balance', 'locked', 'credit', 'fee'])('rechecks %s immediately before debit after preview', async (kind) => {
    const preview = await previewFundOrder(ctx, input, now)
    if (kind === 'risk') await db.update(schema.users).set({ riskRating: 'R1' }).where(eq(schema.users.id, userId))
    if (kind === 'suspended') await db.update(schema.bankFunds).set({ purchaseStatus: 'suspended' }).where(eq(schema.bankFunds.code, code))
    if (kind === 'balance') await db.update(schema.accounts).set({ balanceCents: 0 }).where(eq(schema.accounts.id, account))
    if (kind === 'locked') await db.update(schema.cards).set({ status: 'locked' }).where(eq(schema.cards.id, card))
    if (kind === 'credit') await db.update(schema.cards).set({ kind: 'credit' }).where(eq(schema.cards.id, card))
    if (kind === 'fee') await db.update(schema.bankFunds).set({ purchaseFeeBp: 500 }).where(eq(schema.bankFunds.code, code))
    const before = await balance()
    await expect(submitFundOrder(orderContext(), { ...input, confirmationToken: preview.confirmationToken }, kind === 'stale' ? new Date('2026-11-10T00:00:00Z') : now)).rejects.toThrow()
    expect(await balance()).toBe(before)
    expect((await fundPortfolio(userId, now)).orders).toHaveLength(0)
  })
  it('compensates an unconfirmed debit once; a confirmed position requires manual handling', async () => {
    const order = await buy()
    await Promise.all([compensateFundOrder(ctx, order.id, now), compensateFundOrder(ctx, order.id, now)])
    expect(await balance()).toBe(2000000)
    expect((await fundPortfolio(userId, now)).orders[0].status).toBe('cancelled')
    const second = await buy('second')
    await nav('2026-10-20', 10000); await confirmFundOrders(tomorrow)
    await expect(compensateFundOrder(ctx, second.id, tomorrow)).rejects.toThrow('人工')
  })
  it('isolates users and includes pending cash then NAV value in profile/dashboard assets', async () => {
    await buy()
    expect((await fundPortfolio(otherId, now)).orders).toEqual([])
    expect((await computeProfile(userId, now)).metrics.totalAssetsCents).toBe(2000000)
    expect((await getDashboard(userId)).totalAssets).toBe(20000)
    await nav('2026-10-20', 10000); await confirmFundOrders(tomorrow)
    expect((await fundPortfolio(userId, tomorrow)).pendingCents).toBe(0)
    expect((await fundPortfolio(userId, tomorrow)).marketValueCents).toBe(9985)
  })
  it('routes a real customer through password PLUS strong verification on the existing secure page', async () => {
    const preview = await previewFundOrder(ctx, input, now)
    const proposed = await runBankTool(resolveTool('commit_fund_order')!, { ...input, confirmationToken: preview.confirmationToken }, ctx)
    expect(proposed.status).toBe('needs_confirmation')
    if (proposed.status !== 'needs_confirmation') throw new Error('missing confirmation')
    expect(proposed.level).toBe('red')
    expect(await confirmPending({ ctx, actionId: proposed.actionId, resolveTool })).toMatchObject({ ok: false, code: 'card_password_required' })
    const page = await createSecureRequest(ctx, { purpose: 'confirm_action', actionId: proposed.actionId })
    expect(await submitSecureRequest(ctx, page.id, { password: '246810' })).toMatchObject({ ok: false })
    const stepUp = { method: 'fingerprint' as const, ...await beginDemoBiometric(userId, `action:${proposed.actionId}`, 'fingerprint') }
    expect(await submitSecureRequest(ctx, page.id, { password: '246810', stepUp })).toMatchObject({ ok: true })
    const result = await consumeSecureResult(ctx, page.id)
    expect(result).toMatchObject({ output: { status: 'submitted', amountCents: 10000 } })
    expect(await balance()).toBe(1990000)
  })
  it('expert asks for missing risk/needs and rejects invented amount/percentage', async () => {
    const args = AdviceInput.parse({ horizon: 'over_3y', liquidity: 'partial', amountYuan: 500 })
    await expect(getWealthAdvice(ctx, args, now)).rejects.toThrow('当前用户请求')
    await expect(getWealthAdvice({ ...ctx, requestText: '投资500元' }, { ...args, targetReturnPct: 18 }, now)).rejects.toThrow('目标收益')
    expect(await getWealthAdvice(ctx, AdviceInput.parse({}), now)).toMatchObject({ status: 'needs_information', picks: [] })
    await db.update(schema.users).set({ riskAssessedAt: null }).where(eq(schema.users.id, userId))
    expect(await getWealthAdvice(ctx, AdviceInput.parse({}), now)).toMatchObject({ status: 'needs_risk_assessment', picks: [] })
  })
  it('uses #7 monthly expenses, reserves six months, reports conflicts and never creates transactions', async () => {
    await db.insert(schema.transactions).values(['2026-07-10', '2026-08-10', '2026-09-10'].map((d, i) => ({ id: `fund_expense_${i}`, accountId: account, amountCents: -100000, category: '生活缴费', counterparty: '测试账单', occurredAt: new Date(d + 'T02:00:00Z') })))
    const before = await balance(), rows = (await db.select().from(schema.transactions).where(eq(schema.transactions.accountId, account))).length
    const result = await getWealthAdvice({ ...ctx, requestText: '我想投资20000元，目标收益18%' }, AdviceInput.parse({ amountYuan: 20000, targetReturnPct: 18, horizon: 'within_3m', liquidity: 'anytime', preference: 'growth' }), now, async () => { throw new Error('offline') })
    expect(result).toMatchObject({ status: 'advice', source: 'rule', budget: { monthlyExpenseCents: 100000, reserveCents: 600000, investableCents: 1400000, amountCents: 1400000 } })
    expect('conflicts' in result && result.conflicts).toContain('amount_exceeds_investable')
    expect(result.picks.length).toBeLessThanOrEqual(3)
    expect(await balance()).toBe(before)
    expect((await db.select().from(schema.transactions).where(eq(schema.transactions.accountId, account))).length).toBe(rows)
    expect((await db.select().from(schema.pendingActions).where(eq(schema.pendingActions.userId, userId))).length).toBe(0)
  })
})
