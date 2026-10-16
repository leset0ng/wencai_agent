import type { InteractionSnapshot } from './interaction-message'
/** Only this turn's task/template may turn query results into business selectors. */
export function displayPurpose(snapshot: InteractionSnapshot): 'query' | 'selection' | 'assessment' {
  const text = snapshot.requests.at(-1) ?? ''
  if (/风险.{0,4}(?:测评|评估|评定)|重新(?:测评|评估)|风险偏好/.test(text)) return 'assessment'
  if (snapshot.template) return snapshot.template.intent === 'query' ? 'query' : 'selection'
  if (/查询|查一下|查看|只读|仅展示/.test(text)) return 'query'
  return /转账|转\s*\d|转.{0,10}\d+(?:元|块)|申购|赎回|购买|付款|还款|取消订阅|选择/.test(text) ? 'selection' : 'query'
}
