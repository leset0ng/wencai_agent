export const WEALTH_PERIODS = ['day', 'week', 'month', '3m', '6m', '1y', '3y', '5y', 'all'] as const
export type WealthPeriod = typeof WEALTH_PERIODS[number]
export const PERIOD_LABELS: Record<WealthPeriod, string> = { day: '日', week: '周', month: '月', '3m': '三月', '6m': '六月', '1y': '一年', '3y': '三年', '5y': '五年', all: '成立以来' }
export const PERIOD_TITLES: Record<WealthPeriod, string> = { day: '日', week: '近1周', month: '近1月', '3m': '近3月', '6m': '近6月', '1y': '近1年', '3y': '近3年', '5y': '近5年', all: '成立以来' }
export const RANK_METRICS = ['returnPct', 'sharpe', 'maxDrawdownPct', 'volatilityPct', 'annualizedReturnPct'] as const
export type RankMetric = typeof RANK_METRICS[number]
export const METRIC_LABELS: Record<RankMetric, string> = { returnPct: '涨跌幅', sharpe: '夏普率', maxDrawdownPct: '最大回撤', volatilityPct: '年化波动率', annualizedReturnPct: '年化收益率' }
export interface WealthMetrics {
  period: WealthPeriod; startDate: string | null; endDate: string | null; targetDate: string | null;
  status: 'complete' | 'insufficient_history' | 'missing_inception' | 'data_gap'; reason: string | null;
  returnPct: number | null; navChange: number | null; annualizedReturnPct: number | null;
  sharpe: number | null; maxDrawdownPct: number | null; volatilityPct: number | null; calmar: number | null;
  observations: number; basis: 'published_daily_return' | 'cumulative_nav_approximation';
  points: { date: string; value: number }[];
}
export interface FundMetadata { institution?: string; inceptionDate?: string; scaleYiYuan?: number; scaleDate?: string; endpoint?: string }
export interface WealthRow {
  code: string; name: string; category: string; riskRating: string; institution: string; inceptionDate: string | null;
  scaleYiYuan: number | null; scaleDate: string | null; source: string; fetchedAt: string; stale: boolean;
  unitNav: number | null; navDate: string | null; purchaseStatus: string; enabled: boolean; favorite: boolean;
  metrics: WealthMetrics; rank: number | null;
}
export interface WealthMarket {
  period: WealthPeriod; sortBy: RankMetric; direction: 'asc' | 'desc'; items: WealthRow[]; universeCount: number;
  institutions: string[]; watchlist: string[]; asOf: string;
  methodology: { riskFreeAnnualPct: number; annualizationDays: number; minSharpeReturns: number; note: string };
}
