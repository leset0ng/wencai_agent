import { z } from 'zod'
import { allowedFund } from './pool'

export const cstDate = (now: Date) => new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => {
  const d = new Date(s + 'T00:00:00Z')
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s
})
export const SnapshotSchema = z.object({
  code: z.string().regex(/^\d{6}$/), name: z.string().min(1).max(80),
  purchaseStatus: z.enum(['open', 'limited', 'suspended']), redeemStatus: z.enum(['open', 'suspended']),
  purchaseFeeRate: z.number().min(0).max(.05), minPurchaseCents: z.number().int().positive().max(100_000_000),
  metadata: z.object({ institution: z.string().max(80).optional(), inceptionDate: dateSchema.optional(), scaleYiYuan: z.number().nonnegative().max(100000).optional(), scaleDate: dateSchema.optional(), endpoint: z.string().max(80).optional() }).optional(),
  navs: z.array(z.object({ date: dateSchema, unitNav: z.number().positive().lt(1000), accNav: z.number().positive().lt(1000), dailyReturnPct: z.number().gt(-100).max(10000).optional() })).min(1).max(15000),
  source: z.enum(['eastmoney', 'eastmoney_json', 'fixture', 'tushare']), fetchedAt: z.iso.datetime(),
})
export type FundSnapshot = z.infer<typeof SnapshotSchema>
export interface FundDataProvider { fetch(code: string, signal: AbortSignal): Promise<FundSnapshot> }
export function validateSnapshot(raw: unknown, code: string, now = new Date()): FundSnapshot {
  const data = SnapshotSchema.parse(raw), expected = allowedFund(code)
  if (data.code !== code || data.name !== expected.name) throw new Error('FUND_NAME_MISMATCH')
  if (new Date(data.fetchedAt) > now) throw new Error('FUND_FUTURE_FETCH')
  let previous = ''
  for (const nav of data.navs) {
    if (nav.date <= previous || nav.date > cstDate(now)) throw new Error('FUND_NAV_DATE_INVALID')
    if (Math.round(nav.unitNav * 10000) <= 0 || Math.round(nav.accNav * 10000) <= 0) throw new Error('FUND_NAV_PRECISION_INVALID')
    previous = nav.date
  }
  return data
}
/** 保守工作日新鲜度；只用于拒绝过期申购，成交选净值不依赖交易日历。 */
export function staleNav(date: string, now: Date) {
  const end = cstDate(now)
  let d = new Date(date + 'T00:00:00Z'), weekdays = 0
  while (d.toISOString().slice(0, 10) < end && weekdays <= 3) {
    d = new Date(d.getTime() + 86400_000)
    if (![0, 6].includes(d.getUTCDay())) weekdays++
  }
  return weekdays > 3
}
