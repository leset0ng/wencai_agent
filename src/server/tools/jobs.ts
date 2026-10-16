/**
 * 到期任务执行器：admin 后台与 Agent 系统工具（advance_simulation_clock / run_due_jobs）共用。
 */
import { and, eq, inArray, lte } from 'drizzle-orm'
import { db, schema } from '#/server/db/client'

export type JobResult = { id: string; kind: string; status: 'succeeded' | 'failed' | 'awaiting_confirmation'; message?: string }

/** 仿真时钟：读 settings 表，未设置则返回当前时间 */
export async function simNow(): Promise<Date> {
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, 'clock'))
  return row ? new Date(row.value) : new Date()
}

export type RiskRating = 'R1' | 'R2' | 'R3' | 'R4' | 'R5'

/** 风险测评计分：五项答案（1–5），与 ai-banking-agent 口径一致 */
export function scoreRisk(answers: number[]): RiskRating {
  const sum = answers.reduce((a, b) => a + b, 0)
  const level = Math.min(5, Math.max(1, Math.ceil((sum - 4) / 4.2)))
  return `R${level}` as RiskRating
}

/** 执行 dueAt <= now 的待执行任务 */
export async function runDueJobs(userId: string, now: Date): Promise<JobResult[]> {
  await (await import('#/server/life/service')).runLifeAutomation(userId,now)
  const pending = await db
    .select()
    .from(schema.scheduledTasks)
    .where(
      and(
        eq(schema.scheduledTasks.userId, userId),
        eq(schema.scheduledTasks.status, 'pending'),
        lte(schema.scheduledTasks.dueAt, now.toISOString()),
      ),
    )
  const results: JobResult[] = []
  const { runAutomaticTransfers } = await import('#/server/automation/service')
  await runAutomaticTransfers(userId, now)
  // 常设授权同样只在到期时由后台触发，不是模型可调用的动作
  const mandateRuns = await (await import('#/server/automation/mandates')).runDueMandates(userId, now)
  for (const run of mandateRuns) {
    results.push({ id: run.mandateId, kind: 'mandate', status: run.status === 'executed' ? 'succeeded' : 'failed', message: run.message })
  }
  if (pending.length) for (const task of await db.select().from(schema.scheduledTasks).where(inArray(schema.scheduledTasks.id, pending.map((p) => p.id)))) {
    if (['succeeded', 'failed', 'awaiting_confirmation'].includes(task.status)) results.push({ id: task.id, kind: task.kind, status: task.status as JobResult['status'], message: task.resultJson ? JSON.parse(task.resultJson).message : undefined })
  }
  return results
}
