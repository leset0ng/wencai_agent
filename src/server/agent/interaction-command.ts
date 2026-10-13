import type { AgentContext } from './context'
import { getConfirmationResult } from '#/server/confirm/result'
import { cancelActionAndPlan } from '#/server/executor/service'

/** Message actions never authorize a transaction. Verification/receipt turns are read-only. */
export async function resolveInteractionCommand(ctx: AgentContext, input: { confirmedActionId?: string; verificationActionId?: string; cancelActionId?: string }) {
  const actionId = input.verificationActionId ?? input.cancelActionId
  if (!actionId) return input.confirmedActionId
  const result = await getConfirmationResult(ctx.userId, actionId)
  if (result.status === 'not_found') throw new Error('该操作不存在或不属于当前用户')
  if (input.cancelActionId && ['pending', 'expired'].includes(result.status)) {
    try { await cancelActionAndPlan(ctx, actionId) }
    catch (error) {
      const latest = await getConfirmationResult(ctx.userId, actionId)
      if (latest.status === 'pending' || latest.status === 'expired') throw error
    }
  }
  return actionId
}

/** The receipt is bank-owned: waiting for verification must not be mistaken for a missing transaction. */
export function interactionReceiptText(receipt: { status: string }) {
  switch (receipt.status) {
    case 'pending': return '确认单已核对。请在独立安全页面完成验证；验证通过前不会执行。'
    case 'cancelled': return '本次操作已取消。上方原卡片仍可重新办理。'
    case 'expired': return '本次确认单已过期。请点击原卡片的“重新办理”获取新的确认单。'
    case 'completed': return '该操作已完成，请以已显示的银行回执为准。不会重复执行。'
    case 'processing': return '操作正在执行，请等待银行回执，勿重复提交。'
    case 'failed': return '本次操作执行失败，请核对结果后重新办理。'
    default: return '该操作不存在或不属于当前用户，请重新查询。'
  }
}
