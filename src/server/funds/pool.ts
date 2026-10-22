/** 人工维护的演示适当性分级；不声称是销售机构的正式风险评级。禁止根据名称/收益自动升降级。 */
import type { InvestmentProfile } from '#/lib/fund-preferences'
export const FUND_POOL = [
  { code: '110007', name: '易方达稳健收益债券A', category: 'bond', riskRating: 'R2', assetClass: 'fixed_income', style: 'bond_plus', suggestedHorizonDays: 365 },
  { code: '000171', name: '易方达裕丰回报债券A', category: 'bond', riskRating: 'R3', assetClass: 'fixed_income', style: 'bond_plus', suggestedHorizonDays: 365 },
  { code: '110022', name: '易方达消费行业股票', category: 'equity', riskRating: 'R4', assetClass: 'domestic_equity', style: 'consumer', suggestedHorizonDays: 1095 },
  { code: '161725', name: '招商中证白酒指数(LOF)A', category: 'index', riskRating: 'R4', assetClass: 'domestic_equity', style: 'consumer', suggestedHorizonDays: 1095 },
  { code: '006989', name: '建信中短债纯债债券A', category: 'bond', riskRating: 'R2', assetClass: 'fixed_income', style: 'short_duration', suggestedHorizonDays: 90 },
  { code: '006804', name: '富国短债债券型A', category: 'bond', riskRating: 'R2', assetClass: 'fixed_income', style: 'short_duration', suggestedHorizonDays: 90 },
  { code: '000015', name: '华夏纯债债券A', category: 'bond', riskRating: 'R2', assetClass: 'fixed_income', style: 'pure_bond', suggestedHorizonDays: 180 },
  { code: '003376', name: '广发中债7-10年国开债指数A', category: 'bond', riskRating: 'R3', assetClass: 'fixed_income', style: 'interest_rate', suggestedHorizonDays: 365 },
  { code: '006961', name: '南方中债7-10年国开行债券指数A', category: 'bond', riskRating: 'R3', assetClass: 'fixed_income', style: 'interest_rate', suggestedHorizonDays: 365 },
  { code: '110027', name: '易方达安心回报债券A', category: 'bond', riskRating: 'R3', assetClass: 'fixed_income', style: 'bond_plus', suggestedHorizonDays: 365 },
  { code: '110020', name: '易方达沪深300ETF联接A', category: 'index', riskRating: 'R4', assetClass: 'domestic_equity', style: 'broad_market', suggestedHorizonDays: 1095 },
  { code: '110026', name: '易方达创业板ETF联接A', category: 'index', riskRating: 'R4', assetClass: 'domestic_equity', style: 'growth_index', suggestedHorizonDays: 1095 },
  { code: '050025', name: '博时标普500ETF联接A', category: 'qdii', riskRating: 'R4', assetClass: 'global_equity', style: 'us_broad', suggestedHorizonDays: 1095 },
  { code: '270042', name: '广发纳斯达克100ETF联接人民币(QDII)A', category: 'qdii', riskRating: 'R4', assetClass: 'global_equity', style: 'us_tech', suggestedHorizonDays: 1095 },
  { code: '005827', name: '易方达蓝筹精选混合', category: 'mixed', riskRating: 'R4', assetClass: 'multi_asset', style: 'active_mixed', suggestedHorizonDays: 1095 },
  { code: '161005', name: '富国天惠成长混合(LOF)A', category: 'mixed', riskRating: 'R4', assetClass: 'multi_asset', style: 'active_mixed', suggestedHorizonDays: 1095 },
  { code: '003095', name: '中欧医疗健康混合A', category: 'mixed', riskRating: 'R4', assetClass: 'domestic_equity', style: 'healthcare', suggestedHorizonDays: 1095 },
  { code: '161726', name: '招商国证生物医药指数(LOF)A', category: 'index', riskRating: 'R4', assetClass: 'domestic_equity', style: 'healthcare', suggestedHorizonDays: 1095 },
  { code: '005939', name: '工银新能源汽车混合A', category: 'mixed', riskRating: 'R4', assetClass: 'domestic_equity', style: 'new_energy', suggestedHorizonDays: 1095 },
  { code: '000216', name: '华安黄金ETF联接A', category: 'commodity', riskRating: 'R4', assetClass: 'gold', style: 'gold', suggestedHorizonDays: 1095 },
  { code: '000001', name: '华夏成长混合', category: 'mixed', riskRating: 'R4', assetClass: 'multi_asset', style: 'active_mixed', suggestedHorizonDays: 1095 },
] as const satisfies readonly (InvestmentProfile & { code: string; name: string; category: string; riskRating: string })[]
export function allowedFund(code: string) {
  const fund = FUND_POOL.find((f) => f.code === code)
  if (!fund) throw new Error('FUND_NOT_ALLOWED: 基金不在人工维护的白名单中')
  return fund
}
