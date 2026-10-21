import type { WealthMetrics, WealthPeriod } from '#/lib/wealth'

export interface AnalyticsNav { navDate: string; unitNavE4?: number; accNavE4: number; dailyReturnE8?: number | null }
export const METHODOLOGY = {
  riskFreeAnnualPct: 0, annualizationDays: 252, minSharpeReturns: 20,
  note: '历史指标由服务端统一计算，非平台官方评级。默认无风险年利率0%，一年252个净值收益观察；夏普=日超额收益均值/样本标准差×√252，至少20个收益样本。含分红日采用公布日收益率连接复利序列；缺少时按累计净值近似，明确标注。短周期年化不展示。',
}
const round = (n: number, digits = 4) => Number.isFinite(n) ? Math.round(n * 10 ** digits) / 10 ** digits : null
export function periodTarget(end: string, period: WealthPeriod) {
  const date = new Date(end + 'T00:00:00Z')
  if (period === 'day' || period === 'all') return null
  if (period === 'week') return new Date(date.getTime() - 7 * 86400_000).toISOString().slice(0, 10)
  const months = { month: 1, '3m': 3, '6m': 6, '1y': 12, '3y': 36, '5y': 60 }[period]
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - months, 1))
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(Math.min(date.getUTCDate(), lastDay))
  return target.toISOString().slice(0, 10)
}
export function analyzeFund(navs: AnalyticsNav[], period: WealthPeriod, inceptionDate?: string, riskFreeAnnualPct = 0): WealthMetrics {
  const last = navs.at(-1), targetDate = last ? periodTarget(last.navDate, period) : null
  const base: WealthMetrics = { period, startDate: null, endDate: last?.navDate ?? null, targetDate,
    status: 'insufficient_history', reason: '历史净值不足以覆盖本周期', returnPct: null, navChange: null, annualizedReturnPct: null,
    sharpe: null, maxDrawdownPct: null, volatilityPct: null, calmar: null, observations: 0,
    basis: 'cumulative_nav_approximation', points: [], }
  if (navs.length < 2 || !last) return base
  let start = period === 'day' ? navs.length - 2 : period === 'all' ? 0 : -1
  if (targetDate) for (let i = navs.length - 1; i >= 0; i--) { if (navs[i].navDate <= targetDate) { start = i; break } }
  if (start < 0) return base
  const window = navs.slice(start), first = window[0]
  base.startDate = first.navDate; base.observations = window.length
  if (period === 'all' && (!inceptionDate || Math.abs(Date.parse(first.navDate) - Date.parse(inceptionDate)) > 7 * 86400_000)) {
    return { ...base, status: 'missing_inception', reason: '未取得覆盖成立日期的完整历史，不将已有区间冒充成立以来' }
  }
  if (targetDate && Date.parse(targetDate) - Date.parse(first.navDate) > 14 * 86400_000) return { ...base, status: 'data_gap', reason: '周期起点附近缺少净值' }
  const published = window.slice(1).every((n) => n.dailyReturnE8 !== null && n.dailyReturnE8 !== undefined)
  const changes = window.slice(1).map((n, i) => published ? n.dailyReturnE8! / 1e8 : n.accNavE4 / window[i].accNavE4 - 1)
  if (changes.some((n) => !Number.isFinite(n) || n <= -1)) return { ...base, status: 'data_gap', reason: '净值收益序列无效' }
  // Large gaps cannot yield trustworthy daily volatility/Sharpe (a missing day isn't a zero-return day).
  const gapped = window.some((n, i) => i > 0 && Date.parse(n.navDate) - Date.parse(window[i - 1].navDate) > 14 * 86400_000)
  let value = 100, peak = 100, drawdown = 0
  const points = [{ date: first.navDate, value }]
  for (let i = 0; i < changes.length; i++) {
    value *= 1 + changes[i]
    if (!Number.isFinite(value) || value <= 0) return { ...base, status: 'data_gap', reason: '收益序列超出有效数值范围' }
    peak = Math.max(peak, value); drawdown = Math.max(drawdown, 1 - value / peak); points.push({ date: window[i + 1].navDate, value: round(value, 6)! })
  }
  const mean = changes.reduce((s, n) => s + n, 0) / changes.length
  const variance = changes.reduce((s, n) => s + (n - mean) ** 2, 0) / (changes.length - 1), deviation = Math.sqrt(variance)
  const enough = changes.length >= METHODOLOGY.minSharpeReturns && !gapped
  const days = (Date.parse(last.navDate) - Date.parse(first.navDate)) / 86400_000
  const annualized = days >= 90 && !gapped ? round((Math.pow(value / 100, 365.25 / days) - 1) * 100) : null
  return { ...base, status: 'complete', reason: gapped ? '存在超过14日的净值间隔，暂停夏普和年化波动统计' : enough ? null : '少于20个收益样本，夏普率和年化波动率不展示',
    returnPct: round(value - 100), navChange: first.unitNavE4 && last.unitNavE4 ? round((last.unitNavE4 - first.unitNavE4) / 10000, 4) : null,
    annualizedReturnPct: annualized, sharpe: enough && deviation > 1e-12 ? round((mean - (Math.pow(1 + riskFreeAnnualPct / 100, 1 / 252) - 1)) / deviation * Math.sqrt(252)) : null,
    maxDrawdownPct: round(drawdown * 100), volatilityPct: enough ? round(deviation * Math.sqrt(252) * 100) : null,
    calmar: annualized !== null && drawdown > 0 ? round(annualized / (drawdown * 100)) : null,
    basis: published ? 'published_daily_return' : 'cumulative_nav_approximation', points }
}
/** Preserve first/last and local extrema per bucket, so a downsampled chart doesn't invent a smoother risk profile. */
export function chartPoints(points: WealthMetrics['points'], max = 240) {
  if (points.length <= max) return points
  const result = [points[0]], size = Math.ceil((points.length - 2) / Math.max(1, Math.floor((max - 2) / 2)))
  for (let i = 1; i < points.length - 1; i += size) {
    const bucket = points.slice(i, Math.min(i + size, points.length - 1))
    const low = bucket.reduce((a, b) => a.value < b.value ? a : b), high = bucket.reduce((a, b) => a.value > b.value ? a : b)
    for (const point of [low, high].sort((a, b) => a.date.localeCompare(b.date))) if (result.at(-1)?.date !== point.date) result.push(point)
  }
  result.push(points[points.length - 1]); return result
}
