import { confirmLink } from '#/server/confirm/link'
import { audit } from '#/server/audit/log'
import { createPending } from '#/server/confirm/pending'
import { decide } from '#/server/policy/engine'
import { collectFacts } from '#/server/policy/facts'
import type { AgentContext } from '#/server/agent/context'
import type { BankToolDef, ToolOutcome } from './define'
import { sanitizeToolOutput } from './sanitize'

/**
 * 所有工具调用的唯一入口：参数校验 → 采集事实 → 策略判定 → 执行或生成待确认动作。
 * 模型只能走到这里，越过这里的路径（/api/confirm）只对已认证用户开放。
 */
export async function runBankTool(
  def: BankToolDef,
  rawArgs: unknown,
  ctx: AgentContext,
  plan?: { planId: string; nodeId: string },
): Promise<ToolOutcome> {
  const parsed = def.inputSchema.safeParse(rawArgs)
  if (!parsed.success) return { status: 'error', message: `参数无效：${parsed.error.message}` }
  let args = parsed.data as Record<string, unknown>
  try {
    if (def.prepare) args = await def.prepare(args, ctx)
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) }
  }

  await audit(ctx, 'tool_call', { tool: def.name, args, plan })

  const facts = await collectFacts({ userId: ctx.userId, channel: ctx.channel, ...def.factsHint?.(args) })
  const decision = decide({ tool: def.name, baseRisk: def.baseRisk, args, facts })
  await audit(ctx, 'policy_decision', { tool: def.name, decision, facts })

  if (!decision.allowed) return { status: 'denied', reasons: decision.reasons }

  if (decision.level === 'green') {
    try {
      const output = await def.execute(args, ctx)
      const data = await sanitizeToolOutput(ctx, def.name, output, def.catalogFields)
      await audit(ctx, 'tool_result', { tool: def.name, ok: true, output: data })
      return { status: 'done', data }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await audit(ctx, 'tool_result', { tool: def.name, ok: false, message })
      return { status: 'error', message }
    }
  }

  let pending: Awaited<ReturnType<typeof createPending>>
  try {
    pending = await createPending({ ctx, def, args, decision, plan,
      ...(facts.payeeRiskFlag === 'suspected' && facts.payeeRiskAccountId && facts.payeeRiskRevision !== undefined
        ? { riskSnapshot: { accountId: facts.payeeRiskAccountId, revision: facts.payeeRiskRevision } } : {}),
    })
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) }
  }
  // 确认摘要的 value 也可能来自其他用户的 AA 事由/户名，不能绕过输出审核。
  const summary = await sanitizeToolOutput(ctx, def.name, pending.summary)
  if (decision.requiresChannelHandoff) {
    return {
      status: 'needs_handoff',
      actionId: pending.actionId,
      level: pending.level,
      reasons: decision.reasons,
      summary,
      url: confirmLink(pending.actionId),
    }
  }
  return { status: 'needs_confirmation', ...pending, summary, reasons: decision.reasons }
}
