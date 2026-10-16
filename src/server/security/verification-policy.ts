import type { PolicyFacts, RiskLevel } from '#/server/policy/types'
export const TRANSFER_TOOLS = ['transfer', 'commit_transfer', 'commit_scheduled_transfer', 'transfer_between_accounts', 'transfer_between_cards', 'repay_credit_card', 'pay_split_request', 'execute_birthday_order', 'execute_standing_mandate']
export const isTransferTool = (tool: string) => TRANSFER_TOOLS.includes(tool)
export function transferVerification(tool: string, args: Record<string, unknown>, facts: Pick<PolicyFacts, 'payeeRiskFlag'>, effectiveLevel: RiskLevel) {
  const cents = typeof args.amountCents === 'number' ? args.amountCents : typeof args.amount === 'number' ? Math.round(args.amount * 100) : 0
  // Commerce payments share the choice of authentication factors, not transfer daily totals.
  const transfer = isTransferTool(tool) || ['buy_life_product','subscribe_life_service'].includes(tool)
  const dualRequired = transfer && (cents > 300_000 || facts.payeeRiskFlag === 'suspected' || facts.payeeRiskFlag === 'confirmed')
  return { transfer, dualRequired, strongRequired: effectiveLevel === 'red' || dualRequired }
}
