/** 人工维护的演示适当性分级；不声称是销售机构的正式风险评级。禁止根据名称/收益自动升降级。 */
export const FUND_POOL = [
  { code: '110007', name: '易方达稳健收益债券A', category: 'bond', riskRating: 'R2' },
  { code: '000171', name: '易方达裕丰回报债券A', category: 'bond', riskRating: 'R3' },
  { code: '110022', name: '易方达消费行业股票', category: 'equity', riskRating: 'R4' },
  { code: '161725', name: '招商中证白酒指数(LOF)A', category: 'index', riskRating: 'R4' },
] as const
export function allowedFund(code: string) {
  const fund = FUND_POOL.find((f) => f.code === code)
  if (!fund) throw new Error('FUND_NOT_ALLOWED: 基金不在人工维护的白名单中')
  return fund
}
