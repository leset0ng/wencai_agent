import { env } from '#/server/env'
import { confirmPending } from '#/server/confirm/pending'
import { resolveTool } from '#/server/tools/bank'
import type { AgentContext } from '#/server/agent/context'

/** 飞书按钮不携带安全凭据。需要补验证时沿用原确认单跳转，不重新创建或执行交易。 */
export async function confirmFromLark(ctx: AgentContext, actionId: string) {
  const result = await confirmPending({ ctx, actionId, resolveTool })
  const handoff = !result.ok && ['card_password_required', 'step_up_required', 'step_up_failed'].includes(result.code)
    ? `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/confirm/${encodeURIComponent(actionId)}` : undefined
  const message = result.ok ? '✅ 操作已完成。' : handoff
    ? `本次操作尚未执行：${result.message}。请登录同一文财账户，在独立安全页面核对并完成验证：[前往验证](${handoff})`
    : `未能完成：${result.message}`
  return { result, message }
}
