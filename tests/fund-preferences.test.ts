import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db, schema } from '#/server/db/client'
import { FUND_POOL } from '#/server/funds/pool'
import { FixtureProvider } from '#/server/funds/fixture'
import { validateSnapshot } from '#/server/funds/provider'
import { AdviceInput, expertTextViolations, getWealthAdvice, modelAdviceInput, rankCandidates, type AdviceCandidate } from '#/server/funds/advice'
import { fundMetrics } from '#/server/funds/metrics'
import { ensureFundData } from '#/server/funds/store'
import { getWealthMarket, MarketQuery } from '#/server/funds/market'

const now = new Date('2026-10-22T04:00:00Z'), uid = 'fund_preference_customer', aid = 'fund_preference_account', cid = 'fund_preference_card'
const request = AdviceInput.parse({ amountYuan: 5000, horizon: 'over_3y', liquidity: 'partial', preference: 'balanced' })
const ctx = { userId: uid, sessionId: 'preference_browser', channel: 'web' as const, requestText: '投资5000元，资金可放三年以上，只提供建议。' }
const offline = async () => { throw new Error('offline') }
const base: AdviceCandidate = { id: 'sample', name: '名称不能送入模型', kind: 'fund', riskRating: 'R4', minCents: 100, termDays: 0,
  expectedYieldPct: null, metrics: { ...fundMetrics([]), return1yPct: 6, maxDrawdownPct: 30, volatilityPct: 12 }, source: 'fixture', asOf: '2026-10-22',
  investmentProfile: { assetClass: 'domestic_equity', style: 'broad_market', suggestedHorizonDays: 1095 } }

describe('expanded curated universe and preference boundaries', () => {
  it('ships dated validated histories for all 21 products across multiple institutions and directions', async () => {
    expect(FUND_POOL).toHaveLength(21)
    expect(FUND_POOL.filter((f) => f.category === 'bond')).toHaveLength(8)
    expect(new Set(FUND_POOL.map((f) => f.assetClass)).size).toBe(5)
    const institutions = new Set<string>()
    for (const fund of FUND_POOL) {
      const f = validateSnapshot(await new FixtureProvider().fetch(fund.code, AbortSignal.timeout(1000)), fund.code, new Date('2026-11-01T00:00:00Z'))
      expect(f.navs.length).toBeGreaterThan(1000); expect(f.metadata?.inceptionDate).toBeTruthy()
      institutions.add(f.metadata!.institution!)
    }
    expect(institutions.size).toBeGreaterThanOrEqual(8)
  })
  it('growth does not invent an implicit 25% drawdown constraint, but explicit constraints are hard filters', () => {
    expect(rankCandidates([base], { ...request, preference: 'growth' }, 'R4', 500000)).toHaveLength(1)
    expect(rankCandidates([base], { ...request, maxDrawdownPct: 10 }, 'R4', 500000)).toEqual([])
    expect(rankCandidates([{ ...base, metrics: fundMetrics([]) }], { ...request, maxDrawdownPct: 10 }, 'R4', 500000)).toEqual([])
  })
  it('preferences cannot raise suitability risk or overrule horizon, exclusions and liquidity', () => {
    expect(rankCandidates([base], request, 'R2', 500000)).toEqual([])
    expect(rankCandidates([base], { ...request, horizon: '3_12m' }, 'R4', 500000)).toEqual([])
    expect(rankCandidates([base], { ...request, styles: ['broad_market'], avoidStyles: ['broad_market'] }, 'R4', 500000)).toEqual([])
    expect(rankCandidates([base], { ...request, liquidity: 'anytime' }, 'R4', 500000)).toEqual([])
    expect(rankCandidates([base], { ...request, assetClasses: ['gold'] }, 'R4', 500000)).toEqual([])
  })
  it('does not convert a historical drawdown preference into a guaranteed future loss cap', () => {
    const budget = { amountCents: 500000, investableCents: 500000, monthlyExpenseCents: 1000, monthsObserved: 3, reserveCents: 6000 }
    expect(expertTextViolations('未来回撤不超过30%', budget, base)).toContain('drawdown_promise')
    expect(expertTextViolations('未来损失不能由历史回撤推断。', budget, base)).toEqual([])
  })
  it('balanced comparison includes different eligible asset directions without changing hard constraints', () => {
    const bonds = { ...base, id: 'bonds', riskRating: 'R2', investmentProfile: { assetClass: 'fixed_income' as const, style: 'pure_bond' as const, suggestedHorizonDays: 180 } }
    const gold = { ...base, id: 'gold', investmentProfile: { assetClass: 'gold' as const, style: 'gold' as const, suggestedHorizonDays: 1095 } }
    const ranked = rankCandidates([base, { ...base, id: 'duplicate_style' }, bonds, gold], request, 'R4', 500000)
    expect(new Set(ranked.slice(0, 3).map((c) => c.investmentProfile?.assetClass)).size).toBe(3)
    const sent = JSON.stringify(modelAdviceInput(ranked, { amountCents: 500000, investableCents: 500000, monthlyExpenseCents: 1000, monthsObserved: 3, reserveCents: 6000 }, request, []))
    expect(sent).toContain('broad_market'); expect(sent).not.toContain('名称不能送入模型'); expect(sent).not.toContain('duplicate_style')
  })
})

describe('same customer receives different preference-matched advice', () => {
  beforeAll(async () => {
    await ensureFundData()
    await db.insert(schema.users).values({ id: uid, name: '偏好测试', riskRating: 'R4', riskAssessedAt: '2026-10-01T00:00:00Z' })
    await db.insert(schema.accounts).values({ id: aid, userId: uid, name: '偏好资金', balanceCents: 10000000 })
    await db.insert(schema.cards).values({ id: cid, userId: uid, accountId: aid, last4: '7751', kind: 'debit', status: 'active', dailyLimitCents: 5000000 })
    await db.insert(schema.transactions).values([7, 8, 9].map((month) => ({ id: `pref_expense_${month}`, accountId: aid, amountCents: -100000, category: '餐饮', counterparty: '历史消费', occurredAt: new Date(`2026-0${month}-15T04:00:00Z`) })))
  })
  afterAll(async () => {
    await db.delete(schema.transactions).where(eq(schema.transactions.accountId, aid))
    await db.delete(schema.bankCardNumbers).where(eq(schema.bankCardNumbers.cardId, cid))
    await db.delete(schema.bankCardProfiles).where(eq(schema.bankCardProfiles.cardId, cid))
    await db.delete(schema.cards).where(eq(schema.cards.id, cid))
    await db.delete(schema.accounts).where(eq(schema.accounts.id, aid))
    await db.delete(schema.users).where(eq(schema.users.id, uid))
  })
  it.each([['gold', '000216'], ['healthcare', '161726'], ['broad_market', '110020'], ['new_energy', '005939']] as const)('selects %s products rather than repeating the same default picks', async (style, expected) => {
    const result = await getWealthAdvice(ctx, { ...request, styles: [style] }, now, offline)
    expect(result.status).toBe('advice')
    if (!('source' in result)) throw new Error('No advice returned')
    expect(result.source).toBe('rule'); expect(result.picks.some((p) => p.id === expected)).toBe(true)
    expect(result.picks.every((p) => p.investmentProfile?.style === style)).toBe(true)
    expect(result.picks).toHaveLength(1)
  })
  it('returns an unavailable observation list instead of suggesting a paused overseas purchase', async () => {
    const writer = vi.fn(offline)
    const result = await getWealthAdvice(ctx, { ...request, assetClasses: ['global_equity'] }, now, writer)
    expect(result.status).toBe('no_suitable_candidates'); expect(result.picks).toEqual([]); expect(writer).not.toHaveBeenCalled()
    if (!('unavailableMatches' in result)) throw new Error('No availability result')
    expect(result.unavailableMatches.map((p) => p.code)).toEqual(expect.arrayContaining(['050025', '270042']))
    expect(result.conflicts).toContain('matching_products_unavailable')
  })
  it('never invents a numeric drawdown preference and changes neither balances nor orders', async () => {
    await expect(getWealthAdvice(ctx, { ...request, maxDrawdownPct: 10 }, now, offline)).rejects.toThrow('当前用户请求')
    const before = await db.select().from(schema.accounts).where(eq(schema.accounts.id, aid))
    const result = await getWealthAdvice({ ...ctx, requestText: '投资5000元，偏好历史最大回撤不超过10%。' }, { ...request, maxDrawdownPct: 10, assetClasses: ['fixed_income'] }, now, offline)
    if (!('source' in result)) throw new Error('No advice returned')
    expect(result.picks.every((p) => p.metrics.maxDrawdownPct !== null && p.metrics.maxDrawdownPct <= 10)).toBe(true)
    expect(await db.select().from(schema.accounts).where(eq(schema.accounts.id, aid))).toEqual(before)
    expect(await db.select().from(schema.bankFundOrders).where(eq(schema.bankFundOrders.userId, uid))).toEqual([])
  })
  it('ranking endpoint applies the same asset and style vocabulary', async () => {
    const bonds = await getWealthMarket(uid, MarketQuery.parse({ assetClass: 'fixed_income', style: 'interest_rate' }), now)
    expect(bonds.items.map((p) => p.code)).toEqual(expect.arrayContaining(['003376', '006961']))
    expect(bonds.items).toHaveLength(2)
    const health = await getWealthMarket(uid, MarketQuery.parse({ style: 'healthcare' }), now)
    expect(health.items).toHaveLength(2)
  })
})
