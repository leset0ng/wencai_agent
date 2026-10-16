import { createHash, randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, lte } from 'drizzle-orm'
import { db, schema } from '#/server/db/client'
import { audit } from '#/server/audit/log'
import { collectFacts } from '#/server/policy/facts'
import { decide } from '#/server/policy/engine'
import { RISK_ORDER } from '#/server/policy/types'
import { withUserExecutionLock } from '#/server/confirm/lock'
import { settleTransfer } from '#/server/payments/service'
import { parseRiskAcknowledgement, riskAcknowledged } from '#/server/risk/recipient'

let ready: Promise<void> | undefined
export function ensureAutomationSchema() {
  return ready ??= (async () => {
    for (const sql of [
      'CREATE TABLE IF NOT EXISTS bank_notifications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, action_id TEXT, dedupe_key TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, read_at INTEGER)',
      'CREATE TABLE IF NOT EXISTS bank_task_permissions (task_id TEXT PRIMARY KEY, level TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS bank_task_approvals (task_id TEXT PRIMARY KEY, action_id TEXT NOT NULL UNIQUE)',
    ]) await db.$client.execute(sql)
    const columns = await db.$client.execute('PRAGMA table_info(bank_task_permissions)')
    if (!columns.rows.some((row) => row.name === 'payee_risk_json')) {
      try { await db.$client.execute('ALTER TABLE bank_task_permissions ADD COLUMN payee_risk_json TEXT') }
      catch (error) { if (!String(error).includes('duplicate column name')) throw error }
    }
  })().catch((e) => { ready = undefined; throw e })
}
export async function notify(userId: string, type: string, title: string, body: string, dedupeKey: string, actionId?: string) {
  await ensureAutomationSchema()
  await db.insert(schema.bankNotifications).values({ id: `notice_${randomUUID()}`, userId, type, title, body, dedupeKey, actionId, createdAt: new Date() }).onConflictDoNothing()
}
export async function notifications(userId: string) {
  await ensureAutomationSchema()
  return db.select().from(schema.bankNotifications).where(eq(schema.bankNotifications.userId, userId)).orderBy(desc(schema.bankNotifications.createdAt)).limit(50)
}
export function nextSubscriptionCharge(last: Date, cycle: string) {
  const day = last.getUTCDate(), date = new Date(last)
  date.setUTCDate(1)
  if (cycle === 'yearly') date.setUTCFullYear(date.getUTCFullYear() + 1)
  else date.setUTCMonth(date.getUTCMonth() + 1)
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()
  date.setUTCDate(Math.min(day, end))
  return date
}
export async function sendSubscriptionReminders(userId: string, now: Date) {
  const subscriptions = await db.select().from(schema.subscriptions).where(and(eq(schema.subscriptions.userId, userId), eq(schema.subscriptions.status, 'active')))
  const lifeSubscriptions=await (await import('#/server/life/service')).listLifeSubscriptions(userId,now)
  for (const sub of subscriptions) {
    const life=lifeSubscriptions.find(s=>s.id===sub.id)
    if(life?.productId&&!life.nextChargeAt)continue
    if (!sub.lastChargedAt) continue
    const due = life?.nextChargeAt ? new Date(life.nextChargeAt) : nextSubscriptionCharge(sub.lastChargedAt, sub.cycle)
    if (due.getTime() - sub.remindDays * 86400_000 > now.getTime()) continue
    await notify(userId, 'subscription', due < now ? '订阅已到预计续费日' : '订阅即将续费', `${sub.merchant}，预计 ${(sub.amountCents / 100).toFixed(2)} 元，续费日 ${due.toISOString().slice(0, 10)}。可在 Agent 中核对或取消。`, `subscription:${sub.id}:${due.toISOString()}`)
  }
}
export async function detectSubscriptions(userId: string) {
  const accounts = await db.select().from(schema.accounts).where(eq(schema.accounts.userId, userId))
  if (!accounts.length) return []
  const rows = await db.select().from(schema.transactions).where(inArray(schema.transactions.accountId, accounts.map((a) => a.id))).orderBy(desc(schema.transactions.occurredAt))
  const groups = new Map<string, typeof rows>()
  for (const row of rows) {
    if (row.amountCents >= 0 || ['转账', 'AA', '理财', '信用卡还款', '冲正'].includes(row.category)) continue
    const key = `${row.accountId}:${row.counterparty}:${row.amountCents}`
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  return [...groups].flatMap(([key, items]) => {
    if (items.length < 2) return []
    const gaps = items.slice(0, 4).slice(0, -1).map((item, i) => (item.occurredAt.getTime() - items[i + 1].occurredAt.getTime()) / 86400_000)
    const cycle = items.length >= 3 && gaps.every((days) => days >= 25 && days <= 35) ? 'monthly' : gaps.every((days) => days >= 330 && days <= 400) ? 'yearly' : undefined
    if (!cycle) return []
    return [{ candidateId: createHash('sha256').update(`${userId}:${key}`).digest('hex').slice(0, 24), merchant: items[0].counterparty, amount: -items[0].amountCents / 100, cycle, matchedPayments: items.length, lastChargedAt: items[0].occurredAt.toISOString(), nextChargeAt: nextSubscriptionCharge(items[0].occurredAt, cycle).toISOString() }]
  })
}
export async function completeTaskApproval(actionId: string, userId: string, output: unknown) {
  await ensureAutomationSchema()
  const [link] = await db.select().from(schema.bankTaskApprovals).where(eq(schema.bankTaskApprovals.actionId, actionId))
  if (link) await db.update(schema.scheduledTasks).set({ status: 'succeeded', resultJson: JSON.stringify(output) }).where(and(eq(schema.scheduledTasks.id, link.taskId), eq(schema.scheduledTasks.userId, userId), eq(schema.scheduledTasks.status, 'awaiting_confirmation')))
}
export async function cancelScheduled(userId: string, taskId: string) {
  const [task] = await db.select().from(schema.scheduledTasks).where(and(eq(schema.scheduledTasks.id, taskId), eq(schema.scheduledTasks.userId, userId)))
  if (!task || !['pending', 'awaiting_confirmation'].includes(task.status)) throw new Error('只能取消本人尚未执行的任务')
  if (task.kind === 'birthdayOrder') await (await import('./birthdays')).cancelBirthday(userId, JSON.parse(task.payloadJson).planId)
  await db.update(schema.scheduledTasks).set({ status: 'cancelled' }).where(and(eq(schema.scheduledTasks.id, taskId), inArray(schema.scheduledTasks.status, ['pending', 'awaiting_confirmation'])))
  const actionId = JSON.parse(task.resultJson ?? '{}').actionId
  if (actionId) await db.update(schema.pendingActions).set({ status: 'cancelled' }).where(and(eq(schema.pendingActions.id, actionId), eq(schema.pendingActions.userId, userId), eq(schema.pendingActions.status, 'pending')))
  return { taskId, cancelled: true }
}
export async function closeTaskApproval(actionId: string, userId: string, status: 'cancelled' | 'failed') {
  await ensureAutomationSchema()
  const [link] = await db.select().from(schema.bankTaskApprovals).where(eq(schema.bankTaskApprovals.actionId, actionId))
  if (!link) return
  const [task] = await db.update(schema.scheduledTasks).set({ status, resultJson: JSON.stringify({ message: status === 'cancelled' ? '用户取消核对' : '核对已超时或执行失败，请重新发起' }) }).where(and(eq(schema.scheduledTasks.id, link.taskId), eq(schema.scheduledTasks.userId, userId), eq(schema.scheduledTasks.status, 'awaiting_confirmation'))).returning()
  if (task?.kind === 'birthdayOrder') {
    const { cancelBirthday } = await import('./birthdays')
    await cancelBirthday(userId, JSON.parse(task.payloadJson).planId)
  }
}
export async function runAutomaticTransfers(userId: string, now: Date) {
  await ensureAutomationSchema()
  // 新版任务把资金结算与成功状态写在同一事务；宕机后只重试未提交的尝试。
  const interrupted = await db.select().from(schema.scheduledTasks).where(and(eq(schema.scheduledTasks.userId, userId), eq(schema.scheduledTasks.status, 'processing')))
  for (const task of interrupted) {
    const marker = JSON.parse(task.resultJson ?? '{}')
    if (marker.recoveryVersion !== 1 || marker.startedAt > Date.now() - 300_000) continue
    await withUserExecutionLock(userId, () => db.transaction(async (tx) => {
      const [reset] = await tx.update(schema.scheduledTasks).set({ status: 'pending', resultJson: null }).where(and(eq(schema.scheduledTasks.id, task.id), eq(schema.scheduledTasks.status, 'processing'), eq(schema.scheduledTasks.resultJson, task.resultJson!))).returning()
      if (!reset) return
      await tx.update(schema.pendingActions).set({ status: 'cancelled' }).where(and(eq(schema.pendingActions.userId, userId), eq(schema.pendingActions.sessionId, `scheduled:${task.id}`), eq(schema.pendingActions.status, 'pending')))
      await tx.delete(schema.bankTaskApprovals).where(eq(schema.bankTaskApprovals.taskId, task.id))
    }))
  }
  const waiting = await db.select().from(schema.scheduledTasks).where(and(eq(schema.scheduledTasks.userId, userId), eq(schema.scheduledTasks.status, 'awaiting_confirmation')))
  for (const task of waiting) {
    const actionId = JSON.parse(task.resultJson ?? '{}').actionId as string | undefined
    if (!actionId) continue
    const { getConfirmationResult } = await import('#/server/confirm/result')
    const receipt = await getConfirmationResult(userId, actionId)
    if (receipt.status === 'completed') await completeTaskApproval(actionId, userId, receipt.output)
    else if (['expired', 'cancelled', 'failed', 'not_found'].includes(receipt.status)) await withUserExecutionLock(userId, () => closeTaskApproval(actionId, userId, receipt.status === 'cancelled' ? 'cancelled' : 'failed'))
  }
  const due = await db.select().from(schema.scheduledTasks).where(and(eq(schema.scheduledTasks.userId, userId), inArray(schema.scheduledTasks.kind, ['transfer', 'birthdayOrder']), eq(schema.scheduledTasks.status, 'pending'), lte(schema.scheduledTasks.dueAt, now.toISOString())))
  for (const task of due) await withUserExecutionLock(userId, async () => {
    const marker = JSON.stringify({ recoveryVersion: 1, startedAt: Date.now(), token: randomUUID() })
    const [claimed] = await db.update(schema.scheduledTasks).set({ status: 'processing', resultJson: marker }).where(and(eq(schema.scheduledTasks.id, task.id), eq(schema.scheduledTasks.status, 'pending'))).returning()
    if (!claimed) return
    const ctx = { userId, sessionId: `scheduled:${task.id}`, channel: 'web' as const }
    try {
      let args = JSON.parse(task.payloadJson)
      const birthday = task.kind === 'birthdayOrder'
      if (birthday) { const { birthdayOrder } = await import('#/server/tools/birthdays'); args = await birthdayOrder.prepare!(birthdayOrder.inputSchema.parse(args), ctx) }
      const facts = await collectFacts({ userId, channel: 'web', payeeId: args.payeeId, now })
      const decision = decide({ tool: birthday ? 'execute_birthday_order' : 'commit_scheduled_transfer', baseRisk: 'yellow', args, facts })
      await audit(ctx, 'policy_decision', { taskId: task.id, stage: 'scheduled_execution', decision, facts })
      if (!decision.allowed) throw new Error(decision.reasons.join('；'))
      const [permission] = await db.select().from(schema.bankTaskPermissions).where(eq(schema.bankTaskPermissions.taskId, task.id))
      const payeeRisk = parseRiskAcknowledgement(permission?.payeeRiskJson)
      if (!permission || RISK_ORDER[decision.level] > RISK_ORDER[permission.level] || !riskAcknowledged(facts, payeeRisk)) {
        const { createPending } = await import('#/server/confirm/pending')
        const { transfer } = await import('#/server/tools/bank')
        const { birthdayOrder } = await import('#/server/tools/birthdays')
        const def = birthday ? birthdayOrder : transfer
        const input = birthday ? args : { ...args, amount: args.amountCents / 100 }
        await audit(ctx, 'tool_call', { taskId: task.id, tool: def.name, args: input })
        const outcome = await createPending({ ctx, def, args: input, decision,
          ...(facts.payeeRiskFlag === 'suspected' && facts.payeeRiskAccountId && facts.payeeRiskRevision !== undefined
            ? { riskSnapshot: { accountId: facts.payeeRiskAccountId, revision: facts.payeeRiskRevision } } : {}),
        })
        await db.insert(schema.bankTaskApprovals).values({ taskId: task.id, actionId: outcome.actionId })
        await db.update(schema.scheduledTasks).set({ status: 'awaiting_confirmation', resultJson: JSON.stringify({ actionId: outcome.actionId }) }).where(eq(schema.scheduledTasks.id, task.id))
        await notify(userId, 'confirmation', '预约任务需要核对', '执行时风险发生变化或缺少有效授权，请核对并完成验证后执行。', `task:${task.id}:approval`, outcome.actionId)
        return
      }
      const result = birthday ? await (await import('./birthdays')).executeBirthdayOrder(userId, args.planId, now, { id: task.id, marker }, { level: permission.level, actionId: `scheduled:${task.id}` }) : await settleTransfer(args, { ...ctx, authorization: { level: permission.level, actionId: `scheduled:${task.id}`, payeeRisk } }, now, { onSettled: async (tx, transactionId) => {
        const [saved] = await tx.update(schema.scheduledTasks).set({ status: 'succeeded', resultJson: JSON.stringify({ transactionId, amount: args.amountCents / 100 }) }).where(and(eq(schema.scheduledTasks.id, task.id), eq(schema.scheduledTasks.status, 'processing'), eq(schema.scheduledTasks.resultJson, marker))).returning()
        if (!saved) throw new Error('任务执行权已变化，未扣款')
      } })
      await db.update(schema.scheduledTasks).set({ status: 'succeeded', resultJson: JSON.stringify(result) }).where(eq(schema.scheduledTasks.id, task.id))
      await audit(ctx, 'action_executed', { taskId: task.id, tool: birthday ? 'execute_birthday_order' : 'scheduled_transfer', output: result }).catch((error) => console.error('[worker] 业务已执行，审计写入失败', String(error)))
      await notify(userId, 'task', birthday ? '生日计划已执行' : '定时转账已执行', `已执行预约金额 ${(args.amountCents / 100).toFixed(2)} 元。`, `task:${task.id}:done`).catch((error) => console.error('[worker] 业务已执行，通知失败', String(error)))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await db.update(schema.scheduledTasks).set({ status: 'failed', resultJson: JSON.stringify({ message }) }).where(and(eq(schema.scheduledTasks.id, task.id), eq(schema.scheduledTasks.status, 'processing'), eq(schema.scheduledTasks.resultJson, marker)))
      await audit(ctx, 'tool_result', { taskId: task.id, ok: false, message })
      await notify(userId, 'task', '定时任务未完成', message, `task:${task.id}:failed`)
    }
  })
}
