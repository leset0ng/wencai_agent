export const ASSET_CLASSES = ['fixed_income', 'domestic_equity', 'global_equity', 'gold', 'multi_asset', 'bank_wealth'] as const
export type AssetClass = typeof ASSET_CLASSES[number]
export const ASSET_LABELS: Record<AssetClass, string> = { fixed_income: '债券基金', domestic_equity: '境内权益', global_equity: '海外权益', gold: '黄金', multi_asset: '主动混合', bank_wealth: '银行理财' }
export const FUND_STYLES = ['short_duration', 'pure_bond', 'interest_rate', 'bond_plus', 'broad_market', 'growth_index', 'consumer', 'healthcare', 'new_energy', 'active_mixed', 'us_broad', 'us_tech', 'gold'] as const
export type FundStyle = typeof FUND_STYLES[number]
export const STYLE_LABELS: Record<FundStyle, string> = { short_duration: '短债/中短债', pure_bond: '纯债', interest_rate: '长期利率债', bond_plus: '增强债券', broad_market: '宽基指数', growth_index: '成长指数', consumer: '消费主题', healthcare: '医疗健康', new_energy: '新能源', active_mixed: '主动混合', us_broad: '美国宽基', us_tech: '美国科技', gold: '黄金' }
export const FUND_CATEGORY_LABELS: Record<string, string> = { bond: '债券型基金', equity: '股票型基金', index: '指数基金', mixed: '混合型基金', qdii: 'QDII基金', commodity: '黄金基金' }
/** Curated demo suitability metadata, not a contractual holding period or official risk rating. */
export interface InvestmentProfile { assetClass: AssetClass; style: FundStyle; suggestedHorizonDays: number }
