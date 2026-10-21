import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { db, schema } from '#/server/db/client'
import { listFunds, fundDetails, ensureFundSchema } from './store'
import { allowedFund } from './pool'
import { analyzeFund, chartPoints, METHODOLOGY } from './analytics'
import { RANK_METRICS, WEALTH_PERIODS, type FundMetadata, type WealthMarket, type WealthRow } from '#/lib/wealth'

export const MarketQuery = z.object({
  period: z.enum(WEALTH_PERIODS).default('1y'), sortBy: z.enum(RANK_METRICS).default('returnPct'), direction: z.enum(['asc', 'desc']).default('desc'),
  category: z.enum(['all', 'fund', 'bond', 'favorites']).default('all'), institution: z.string().max(80).default(''),
  search: z.string().max(80).default(''), riskMax: z.coerce.number().int().min(1).max(5).default(5),
})
export type MarketRequest = z.infer<typeof MarketQuery>
export async function fundWatchlist(userId: string) {
  await ensureFundSchema()
  return (await db.select().from(schema.bankFundWatchlist).where(eq(schema.bankFundWatchlist.userId, userId))).map((r) => r.code)
}
export async function setFundWatchlist(userId: string, code: string, favorite: boolean) {
  allowedFund(code); await ensureFundSchema()
  if (favorite) await db.insert(schema.bankFundWatchlist).values({ userId, code }).onConflictDoNothing()
  else await db.delete(schema.bankFundWatchlist).where(and(eq(schema.bankFundWatchlist.userId, userId), eq(schema.bankFundWatchlist.code, code)))
  return { code, favorite, watchlist: await fundWatchlist(userId) }
}
export function sortWealthRows(rows: WealthRow[], query: MarketRequest) {
  return [...rows].sort((a, b) => {
    const av = a.metrics[query.sortBy], bv = b.metrics[query.sortBy]
    if (av === null && bv === null) return a.code.localeCompare(b.code)
    if (av === null) return 1; if (bv === null) return -1
    return (query.direction === 'asc' ? av - bv : bv - av) || a.code.localeCompare(b.code)
  }).map((r, i) => ({ ...r, rank: r.metrics[query.sortBy] === null ? null : i + 1 }))
}
export async function getWealthMarket(userId: string, query: MarketRequest, now: Date): Promise<WealthMarket> {
  const funds = await listFunds(now), watchlist = await fundWatchlist(userId)
  const all = await Promise.all(funds.map(async (fund): Promise<WealthRow> => {
    const details = await fundDetails(fund.code, now), meta = JSON.parse(fund.metadataJson) as FundMetadata
    const metrics = analyzeFund(details.navs, query.period, meta.inceptionDate)
    return { code: fund.code, name: fund.name, category: fund.category, riskRating: fund.riskRating,
      institution: meta.institution ?? '机构待补充', inceptionDate: meta.inceptionDate ?? null, scaleYiYuan: meta.scaleYiYuan ?? null,
      scaleDate: meta.scaleDate ?? null, source: fund.source, fetchedAt: fund.updatedAt, stale: fund.stale, unitNav: fund.unitNav,
      navDate: fund.navDate, purchaseStatus: fund.purchaseStatus, enabled: fund.enabled, favorite: watchlist.includes(fund.code),
      metrics: { ...metrics, points: chartPoints(metrics.points) }, rank: null }
  }))
  const search = query.search.trim().toLowerCase()
  const filtered = all.filter((r) => (query.category !== 'bond' || r.category === 'bond') && (query.category !== 'favorites' || r.favorite)
    && (!query.institution || r.institution === query.institution) && Number(r.riskRating.slice(1)) <= query.riskMax
    && (!search || `${r.name} ${r.code} ${r.institution}`.toLowerCase().includes(search)))
  return { period: query.period, sortBy: query.sortBy, direction: query.direction, items: sortWealthRows(filtered, query), universeCount: all.length,
    institutions: [...new Set(all.map((r) => r.institution))].sort(), watchlist, asOf: now.toISOString(), methodology: METHODOLOGY }
}
export async function getFundAnalytics(code: string, now: Date) {
  const fund = await fundDetails(code, now), meta = JSON.parse(fund.metadataJson) as FundMetadata
  const periods = Object.fromEntries(WEALTH_PERIODS.map((period) => {
    const metric = analyzeFund(fund.navs, period, meta.inceptionDate)
    return [period, { ...metric, points: chartPoints(metric.points) }]
  }))
  return { code, name: fund.name, riskRating: fund.riskRating, category: fund.category, ...meta, source: fund.source, fetchedAt: fund.updatedAt,
    navDate: fund.navDate, unitNav: fund.unitNav, stale: fund.stale, periods, methodology: METHODOLOGY }
}
