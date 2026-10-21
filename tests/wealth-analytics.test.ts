import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { analyzeFund, chartPoints, periodTarget } from '#/server/funds/analytics'
import { getFundAnalytics, getWealthMarket, MarketQuery, setFundWatchlist } from '#/server/funds/market'
import { ensureFundData } from '#/server/funds/store'
import { db, schema } from '#/server/db/client'
import { WEALTH_PERIODS } from '#/lib/wealth'
const now = new Date('2026-10-30T04:00:00Z'), user = 'wealth_analytics_customer', other = 'wealth_other'
const series = (count: number) => Array.from({ length: count }, (_, i) => ({ navDate: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), accNavE4: 10000 + i * 3, unitNavE4: 10000 + i * 3, dailyReturnE8: i % 2 ? 200000 : -100000 }))
describe('calendar window and code-calculated fund metrics', () => {
  it.each([['2024-03-31', 'month', '2024-02-29'], ['2025-03-31', 'month', '2025-02-28'], ['2024-02-29', '1y', '2023-02-28'], ['2026-10-20', '3m', '2026-07-20'], ['2026-10-20', '6m', '2026-04-20'], ['2026-10-20', '3y', '2023-10-20'], ['2026-10-20', '5y', '2021-10-20'], ['2026-10-20', 'week', '2026-10-13']] as const)('clamps calendar endpoints %s %s', (end, period, expected) => expect(periodTarget(end, period)).toBe(expected))
  it('day means two consecutive published NAVs and does not invent a daily Sharpe', () => {
    const m = analyzeFund(series(60), 'day')
    expect(m.observations).toBe(2); expect(m.returnPct).toBe(0.2); expect(m.sharpe).toBeNull(); expect(m.annualizedReturnPct).toBeNull()
  })
  it('uses published daily return instead of treating an ex-dividend unit-NAV drop as a loss', () => {
    const m = analyzeFund([{ navDate: '2026-10-19', unitNavE4: 20000, accNavE4: 25000 }, { navDate: '2026-10-20', unitNavE4: 18000, accNavE4: 25100, dailyReturnE8: 500000 }], 'day')
    expect(m.returnPct).toBe(.5); expect(m.navChange).toBe(-.2); expect(m.basis).toBe('published_daily_return')
  })
  it('reproduces Sharpe, volatility, drawdown and compounded return from an independent calculation', () => {
    const data = series(61), metric = analyzeFund(data, 'all', data[0].navDate), changes = data.slice(1).map((r) => r.dailyReturnE8 / 1e8)
    const mean = changes.reduce((s, n) => s + n, 0) / changes.length
    const sd = Math.sqrt(changes.reduce((s, n) => s + (n - mean) ** 2, 0) / (changes.length - 1))
    expect(metric.sharpe!).toBeCloseTo(mean / sd * Math.sqrt(252), 3)
    expect(metric.volatilityPct!).toBeCloseTo(sd * Math.sqrt(252) * 100, 3)
    expect(metric.returnPct!).toBeCloseTo((changes.reduce((v, r) => v * (1 + r), 1) - 1) * 100, 3)
    expect(metric.maxDrawdownPct).toBe(.1)
  })
  it('does not return infinity for zero volatility and does not extrapolate missing history', () => {
    const data = series(30).map((r) => ({ ...r, dailyReturnE8: 0 }))
    expect(analyzeFund(data, 'all', data[0].navDate).sharpe).toBeNull()
    expect(analyzeFund(data, '5y')).toMatchObject({ status: 'insufficient_history', returnPct: null, points: [] })
    expect(analyzeFund(data, 'all')).toMatchObject({ status: 'missing_inception', returnPct: null })
    expect(analyzeFund(data, 'all', '2010-01-01').returnPct).toBeNull()
  })
  it('labels legacy cumulative-NAV approximations and refuses risk statistics across large gaps', () => {
    const data = series(60).map(({ dailyReturnE8: _, ...r }) => r)
    expect(analyzeFund(data, 'all', data[0].navDate).basis).toBe('cumulative_nav_approximation')
    const last = data.at(-1)!
    const m = analyzeFund([...data, { ...last, navDate: '2026-10-20' }], 'all', data[0].navDate)
    expect(m.sharpe).toBeNull(); expect(m.volatilityPct).toBeNull(); expect(m.reason).toContain('14')
  })
  it('subtracts a disclosed risk-free rate and handles absent/empty observations', () => {
    const data = series(60)
    expect(analyzeFund(data, 'all', data[0].navDate, 2).sharpe!).toBeLessThan(analyzeFund(data, 'all', data[0].navDate, 0).sharpe!)
    expect(analyzeFund([], 'month').returnPct).toBeNull()
    expect(analyzeFund(data.slice(0, 1), 'day').returnPct).toBeNull()
  })
  it('downsampling preserves endpoints and a narrow crash extremum', () => {
    const points = Array.from({ length: 5000 }, (_, i) => ({ date: new Date(Date.UTC(2010, 0, 1 + i)).toISOString().slice(0, 10), value: i === 2500 ? 10 : 100 + i / 1000 }))
    const down = chartPoints(points)
    expect(down[0]).toEqual(points[0]); expect(down.at(-1)).toEqual(points.at(-1)); expect(down).toContainEqual(points[2500]); expect(down.length).toBeLessThanOrEqual(240)
  })
})
describe('wealth market service and persistent personal watchlists', () => {
  beforeAll(ensureFundData)
  afterAll(async () => { await db.delete(schema.bankFundWatchlist).where(eq(schema.bankFundWatchlist.userId, user)); await db.delete(schema.bankFundWatchlist).where(eq(schema.bankFundWatchlist.userId, other)) })
  it('has complete real 3y/5y/inception history for all four curated funds', async () => {
    for (const code of ['110007', '000171', '110022', '161725']) {
      const detail = await getFundAnalytics(code, now)
      expect(Object.keys(detail.periods)).toEqual([...WEALTH_PERIODS])
      expect(detail.institution).toBeTruthy(); expect(detail.inceptionDate).toBeTruthy()
      for (const p of ['3y', '5y', 'all']) { expect(detail.periods[p].status).toBe('complete'); expect(detail.periods[p].returnPct).not.toBeNull(); expect(detail.periods[p].sharpe).not.toBeNull() }
    }
  })
  it('sorts all metrics in either direction and matches individual-detail computations', async () => {
    for (const sortBy of ['returnPct', 'sharpe', 'maxDrawdownPct', 'volatilityPct', 'annualizedReturnPct'] as const) {
      const query = MarketQuery.parse({ period: '1y', sortBy, direction: 'desc' }), response = await getWealthMarket(user, query, now)
      expect(response.universeCount).toBe(4)
      const values = response.items.map((r) => r.metrics[sortBy]).filter((n): n is number => n !== null)
      expect(values).toEqual([...values].sort((a, b) => b - a))
      const first = response.items[0], detail = await getFundAnalytics(first.code, now)
      expect(first.metrics.returnPct).toBe(detail.periods['1y'].returnPct)
      const asc = await getWealthMarket(user, { ...query, direction: 'asc' }, now)
      const av = asc.items.map((r) => r.metrics[sortBy]).filter((n): n is number => n !== null)
      expect(av).toEqual([...av].sort((a, b) => a - b))
    }
  })
  it('keeps nulls last and unranked and filters debt funds without calling bank products bonds', async () => {
    const daily = await getWealthMarket(user, MarketQuery.parse({ period: 'day', sortBy: 'sharpe' }), now)
    expect(daily.items.every((r) => r.metrics.sharpe === null && r.rank === null)).toBe(true)
    const bonds = await getWealthMarket(user, MarketQuery.parse({ category: 'bond' }), now)
    expect(bonds.items).toHaveLength(2); expect(bonds.items.every((r) => r.category === 'bond')).toBe(true)
    expect((await getWealthMarket(user, MarketQuery.parse({ search: '招商' }), now)).items.map((r) => r.code)).toEqual(['161725'])
    expect((await getWealthMarket(user, MarketQuery.parse({ riskMax: 2 }), now)).items.every((r) => r.riskRating === 'R2')).toBe(true)
  })
  it('watchlist writes are idempotent, account-scoped and cannot change balances', async () => {
    const before = await db.select().from(schema.accounts)
    await Promise.all([setFundWatchlist(user, '110007', true), setFundWatchlist(user, '110007', true)])
    const mine = await getWealthMarket(user, MarketQuery.parse({ category: 'favorites' }), now)
    expect(mine.items.map((r) => r.code)).toEqual(['110007'])
    expect((await getWealthMarket(other, MarketQuery.parse({ category: 'favorites' }), now)).items).toEqual([])
    await expect(setFundWatchlist(user, '999999', true)).rejects.toThrow('FUND_NOT_ALLOWED')
    await setFundWatchlist(user, '110007', false)
    expect((await getWealthMarket(user, MarketQuery.parse({ category: 'favorites' }), now)).items).toEqual([])
    expect(await db.select().from(schema.accounts)).toEqual(before)
  })
})
