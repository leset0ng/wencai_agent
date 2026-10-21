import { analyzeFund, type AnalyticsNav } from './analytics'
export interface NavPoint extends AnalyticsNav {}
/** Historical returns use cumulative NAV; NAVs are public observations, never expected future yields. */
export function fundMetrics(navs: NavPoint[]) {
  const value = (period: 'month' | '3m' | '6m' | '1y') => analyzeFund(navs, period).returnPct
  const all = analyzeFund(navs, 'all', navs[0]?.navDate)
  return { return1mPct: value('month'), return3mPct: value('3m'), return6mPct: value('6m'), return1yPct: value('1y'),
    volatilityPct: all.volatilityPct, maxDrawdownPct: navs.length >= 20 ? all.maxDrawdownPct : null, asOf: navs.at(-1)?.navDate ?? null }
}
