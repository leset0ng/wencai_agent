import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { db, schema } from '#/server/db/client'
import { env } from '#/server/env'
import { audit } from '#/server/audit/log'
import type { AgentContext } from '#/server/agent/context'
import type { BankToolDef, ConfirmSummary } from '#/server/tools/define'
import type { PolicyDecision } from '#/server/policy/types'
import { hashParams, signIntegrity, verifyIntegrity } from './integrity'
import { verifyStrongStepUp, type StrongStepUp } from '#/server/auth/step-up'
import { collectFacts } from '#/server/policy/facts'
import { decide } from '#/server/policy/engine'
import { maxRisk } from '#/server/policy/types'
import { withUserExecutionLock } from './lock'
import { pendingRiskSnapshot, savePendingRiskSnapshot } from '#/server/risk/pending'

export async function createPending(params: {
  ctx: AgentContext
  def: BankToolDef
  args: unknown
  decision: PolicyDecision
  plan?: { planId: string; nodeId: string }
  riskSnapshot?: { accountId: string; revision: number }
}): Promise<{ actionId: string; level: 'yellow' | 'red'; summary: ConfirmSummary; expiresAt: number }> {
  const { ctx, def, args, decision } = params
  const level = decision.level === 'red' ? 'red' : 'yellow'
  const id = `pa_${randomUUID()}`
  const paramsHash = hashParams(args)
  const expiresAt = Date.now() + env.CONFIRM_TTL_SECONDS * 1000
  const integrity = signIntegrity(env.CONFIRM_SECRET, {
    id,
    userId: ctx.userId,
    tool: def.name,
    paramsHash,
    level,
    expiresAt,
  })
  const summary = await def.summarize!(args, ctx)

  await db.insert(schema.pendingActions).values({
    id,
    userId: ctx.userId,
    sessionId: ctx.sessionId,
    tool: def.name,
    argsJson: JSON.stringify(args),
    paramsHash,
    level,
    reasonsJson: JSON.stringify(decision.reasons),
    summaryJson: JSON.stringify(summary),
    integrity,
    expiresAt: new Date(expiresAt),
    status: 'pending',
    planId: params.plan?.planId,
    nodeId: params.plan?.nodeId,
    createdAt: new Date(),
  })
  await audit(ctx, 'pending_created', { actionId: id, tool: def.name, level, reasons: decision.reasons })
  if (params.riskSnapshot) await savePendingRiskSnapshot(id, params.riskSnapshot)
  return { actionId: id, level, summary, expiresAt }
}

export type StepUp = StrongStepUp

export type ConfirmResult =
  | { ok: true; tool: string; output: unknown; planId?: string; nodeId?: string; plan?: import('#/server/executor/executor').PlanState }
  | { ok: false; code: ConfirmErrorCode; message: string; requiredLevel?: 'red'; reasons?: string[] }

export type ConfirmErrorCode =
  | 'not_found'
  | 'forbidden'
  | 'tampered'
  | 'expired'
  | 'already_used'
  | 'step_up_required'
  | 'step_up_failed'
  | 'locked'
  | 'execution_failed'
  | 'plan_paused'

/**
 * 用户确认入口。只能由已认证的客户端会话调用；系统中不存在可被模型调用的确认工具。
 */
export async function confirmPending(params: {
  ctx: AgentContext
  actionId: string
  stepUp?: StepUp
  resolveTool: (name: string) => BankToolDef | undefined
}): Promise<ConfirmResult> {
  return withUserExecutionLock(params.ctx.userId, () => confirmUnderLock(params))
}

async function confirmUnderLock(params: {
  ctx: AgentContext; actionId: string; stepUp?: StepUp;
  resolveTool: (name: string) => BankToolDef | undefined
}): Promise<ConfirmResult> {
  const { ctx, actionId, stepUp } = params
  const fail = async (code: ConfirmErrorCode, message: string, reasons?: string[]): Promise<ConfirmResult> => {
    await audit(ctx, 'confirm_attempt', { actionId, ok: false, code, message })
    return { ok: false, code, message, ...(reasons ? { reasons } : {}), ...(code === 'step_up_required' ? { requiredLevel: 'red' as const } : {}) }
  }

  const [row] = await db.select().from(schema.pendingActions).where(eq(schema.pendingActions.id, actionId))
  if (!row) return fail('not_found', '待确认操作不存在')
  if (row.userId !== ctx.userId) return fail('forbidden', '无权确认该操作')

  const intact =
    hashParams(JSON.parse(row.argsJson)) === row.paramsHash &&
    verifyIntegrity(
      env.CONFIRM_SECRET,
      { id: row.id, userId: row.userId, tool: row.tool, paramsHash: row.paramsHash, level: row.level, expiresAt: row.expiresAt.getTime() },
      row.integrity,
    )
  if (!intact) return fail('tampered', '操作数据校验失败，已拒绝')
  if (row.status !== 'pending') return fail('already_used', '该操作已处理')
  if (row.expiresAt.getTime() < Date.now()) return fail('expired', '确认已超时，请重新发起')
  if (row.sessionId.startsWith('scheduled:')) {
    const { ensureAutomationSchema } = await import('#/server/automation/service')
    await ensureAutomationSchema()
    const [link] = await db.select().from(schema.bankTaskApprovals).where(eq(schema.bankTaskApprovals.actionId, row.id))
    const [task] = link ? await db.select().from(schema.scheduledTasks).where(and(eq(schema.scheduledTasks.id, link.taskId), eq(schema.scheduledTasks.userId, ctx.userId))) : []
    if (!task || task.status !== 'awaiting_confirmation') return fail('already_used', '预约任务已处理或执行权已变化，请在任务中心核对')
  }
  if (row.planId) {
    const [plan] = await db.select().from(schema.plans).where(and(eq(schema.plans.id, row.planId), eq(schema.plans.userId, ctx.userId)))
    if (!plan) return fail('not_found', '关联计划不存在')
    if (plan.status === 'paused') return fail('plan_paused', '任务已暂停，请先在任务中心恢复')
    if (!['running', 'suspended'].includes(plan.status)) return fail('already_used', '关联计划已终止，请查看任务中心')
  }

  const def = params.resolveTool(row.tool)
  if (!def) return fail('execution_failed', `未知工具 ${row.tool}`)
  const args = JSON.parse(row.argsJson)
  const facts = await collectFacts({ userId: ctx.userId, channel: ctx.channel, ...def.factsHint?.(args) })
  const decision = decide({ tool: def.name, baseRisk: def.baseRisk, args, facts })
  await audit(ctx, 'policy_decision', { actionId, stage: 'execution', tool: row.tool, decision, facts })
  if (!decision.allowed) return fail('locked', decision.reasons.join('；'))
  const effectiveLevel = maxRisk(row.level, decision.level)
  if (effectiveLevel === 'red') {
    const integrity = signIntegrity(env.CONFIRM_SECRET, { id: row.id, userId: row.userId, tool: row.tool, paramsHash: row.paramsHash, level: 'red', expiresAt: row.expiresAt.getTime() })
    await db.update(schema.pendingActions).set({ level: 'red', integrity, reasonsJson: JSON.stringify(decision.reasons) }).where(and(eq(schema.pendingActions.id, row.id), eq(schema.pendingActions.status, 'pending')))
  }
  if (facts.payeeRiskFlag === 'suspected' && facts.payeeRiskAccountId && facts.payeeRiskRevision !== undefined) {
    const shown = await pendingRiskSnapshot(actionId)
    if (shown?.accountId !== facts.payeeRiskAccountId || shown.revision !== facts.payeeRiskRevision) {
      await savePendingRiskSnapshot(actionId, { accountId: facts.payeeRiskAccountId, revision: facts.payeeRiskRevision })
      // Even an old red card must show this NEW warning before accepting an already prepared proof.
      return fail('step_up_required', '该收款账户近期收款特征异常，请核实对方身份，并重新核对本次操作后完成强验证', decision.reasons)
    }
  }

  if (effectiveLevel === 'red') {
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, ctx.userId))
    if (user?.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      return fail('locked', '账户已临时锁定，请联系人工客服')
    }
    if (!stepUp) return fail('step_up_required', '该操作需要强验证', decision.reasons)
    if (!(await verifyStrongStepUp(ctx.userId, `action:${actionId}`, stepUp))) {
      const [current] = await db.select().from(schema.users).where(eq(schema.users.id, ctx.userId))
      if (current?.lockedUntil && current.lockedUntil > new Date()) return fail('locked', '验证连续失败，账户已锁定30分钟')
      return fail('step_up_failed', `验证失败，还可尝试 ${5 - (current?.failedAuthCount ?? 0)} 次`)
    }
  }

  // 原子消费：并发重复提交只有一个能成功
  const consumed = await db
    .update(schema.pendingActions)
    .set({ status: 'consumed' })
    .where(and(eq(schema.pendingActions.id, actionId), eq(schema.pendingActions.status, 'pending')))
    .returning({ id: schema.pendingActions.id })
  if (consumed.length === 0) return fail('already_used', '该操作已处理')

  try {
    const output = await def.execute(JSON.parse(row.argsJson), { ...ctx, authorization: {
      level: effectiveLevel === 'red' ? 'red' : 'yellow', actionId,
      ...(facts.payeeRiskFlag === 'suspected' && facts.payeeRiskAccountId && facts.payeeRiskRevision !== undefined
        ? { payeeRisk: { accountId: facts.payeeRiskAccountId, revision: facts.payeeRiskRevision } } : {}),
    } })
    await audit(ctx, 'confirm_attempt', { actionId, ok: true })
    await audit(ctx, 'action_executed', { actionId, tool: row.tool, output })
    const { completeTaskApproval } = await import('#/server/automation/service')
    await completeTaskApproval(actionId, ctx.userId, output).catch((error) => audit(ctx, 'tool_result', { actionId, ok: false, stage: 'task_receipt', message: String(error) }))
    let plan: import('#/server/executor/executor').PlanState | undefined
    if (row.planId && row.nodeId) {
      const { resumePlan } = await import('#/server/executor/service')
      try { plan = await resumePlan(ctx, row.planId, row.nodeId, output) }
      catch (error) { await audit(ctx, 'handoff', { actionId, planId: row.planId, reason: 'resume_failed', message: String(error) }) }
    }
    return { ok: true, tool: row.tool, output, planId: row.planId ?? undefined, nodeId: row.nodeId ?? undefined, plan }
  } catch (err) {
    return fail('execution_failed', err instanceof Error ? err.message : String(err))
  }
}

/** 供 H5 跳转页展示：仅返回属于当前用户的待确认动作 */
export async function getPendingForUser(ctx: AgentContext, actionId: string) {
  const [row] = await db
    .select()
    .from(schema.pendingActions)
    .where(and(eq(schema.pendingActions.id, actionId), eq(schema.pendingActions.userId, ctx.userId)))
  if (!row) return null
  return {
    actionId: row.id,
    level: row.level,
    status: row.expiresAt.getTime() < Date.now() && row.status === 'pending' ? 'expired' : row.status,
    reasons: JSON.parse(row.reasonsJson) as string[],
    summary: JSON.parse(row.summaryJson) as ConfirmSummary,
    expiresAt: row.expiresAt.getTime(),
  }
}

export async function cancelPending(ctx: AgentContext, actionId: string): Promise<void> {
  await db
    .update(schema.pendingActions)
    .set({ status: 'cancelled' })
    .where(
      and(
        eq(schema.pendingActions.id, actionId),
        eq(schema.pendingActions.userId, ctx.userId),
        eq(schema.pendingActions.status, 'pending'),
      ),
    )
  await audit(ctx, 'confirm_attempt', { actionId, cancelled: true })
  const { closeTaskApproval } = await import('#/server/automation/service')
  await closeTaskApproval(actionId, ctx.userId, 'cancelled')
}
