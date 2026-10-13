import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db, schema } from '#/server/db/client'
import { advance, initPlanState } from '#/server/executor/executor'
import type { NodeRunner } from '#/server/executor/executor'
import { controlPlan, startPlan } from '#/server/executor/service'
import type { Plan } from '#/server/planner/dag'

const userId = 'u_plan_interrupt'
const ctx = { userId, sessionId: 'plan-interrupt', channel: 'web' as const }
const allowed = new Set(['get_accounts', 'list_products', 'list_subscriptions'])
const steps = {
  goal: '依次查询三项信息',
  nodes: [
    { id: 'n1', kind: 'tool', tool: 'get_accounts', args: {}, dependsOn: [] },
    { id: 'n2', kind: 'tool', tool: 'list_products', args: {}, dependsOn: ['n1'] },
    { id: 'n3', kind: 'tool', tool: 'list_subscriptions', args: {}, dependsOn: ['n2'] },
  ],
}
const row = async (id: string) => (await db.select().from(schema.plans).where(eq(schema.plans.id, id)))[0]
/** 第 n 次被询问时才变为已中断，模拟用户在计划执行途中按下停止 */
const abortOnCheck = (n: number, onTrigger?: () => void) => {
  let reads = 0
  return { get aborted() { reads++; if (reads === n) onTrigger?.(); return !onTrigger && reads >= n } } as AbortSignal
}

beforeAll(async () => {
  await db.delete(schema.plans).where(eq(schema.plans.userId, userId))
  await db.delete(schema.users).where(eq(schema.users.id, userId))
  await db.insert(schema.users).values({ id: userId, name: '中断测试' })
})
afterAll(async () => {
  await db.delete(schema.plans).where(eq(schema.plans.userId, userId))
  await db.delete(schema.users).where(eq(schema.users.id, userId))
})

describe('执行器：节点之间暂停', () => {
  const plan = steps as Plan
  const runner = (calls: string[]): NodeRunner => ({
    run: async (node) => { calls.push(node.id); return { status: 'done', data: {} } },
    compensate: async () => true,
  })

  it('暂停后保留已完成节点，后续节点不执行', async () => {
    const calls: string[] = []
    let checks = 0
    const state = await advance(initPlanState('p', plan), runner(calls), { shouldPause: () => ++checks > 1 })
    expect(calls).toEqual(['n1'])
    expect(state.status).toBe('paused')
    expect(state.nodes.n1.status).toBe('done')
    expect(state.nodes.n2.status).toBe('pending')
  })

  it('暂停后的状态可以继续推进到完成，已完成节点不重复执行', async () => {
    const calls: string[] = []
    let checks = 0
    const paused = await advance(initPlanState('p', plan), runner(calls), { shouldPause: () => ++checks > 2 })
    const done = await advance({ ...paused, status: 'running' }, runner(calls))
    expect(done.status).toBe('completed')
    expect(calls).toEqual(['n1', 'n2', 'n3'])
  })

  it('每个节点完成后报告一次进度', async () => {
    const seen: number[] = []
    await advance(initPlanState('p', plan), runner([]), { onProgress: (s) => { seen.push(s.completed.length) } })
    expect(seen).toEqual([1, 2, 3])
  })
})

describe('计划服务：停止与暂停', () => {
  it('不传中断信号时照常执行到完成', async () => {
    const res = await startPlan(ctx, steps, allowed)
    if (!res.ok) throw new Error(res.errors.join(';'))
    expect(res.state.status).toBe('completed')
    expect((await row(res.state.id)).status).toBe('completed')
  })

  it('执行途中按下停止：计划停在当前步骤并保存为已暂停，写入审计', async () => {
    const res = await startPlan(ctx, steps, allowed, abortOnCheck(2))
    if (!res.ok) throw new Error(res.errors.join(';'))
    expect(res.state.status).toBe('paused')
    expect(res.state.completed).toEqual(['n1'])
    const saved = await row(res.state.id)
    expect(saved.status).toBe('paused')
    expect(JSON.parse(saved.stateJson).nodes.n2.status).toBe('pending')
    const logs = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.userId, userId))
    expect(logs.some((log) => log.type === 'plan_control' && log.payloadJson.includes(res.state.id) && log.payloadJson.includes('"stop"'))).toBe(true)
  })

  it('开始前已中断：不执行任何步骤，但计划仍可在任务中心看到', async () => {
    const controller = new AbortController()
    controller.abort()
    const res = await startPlan(ctx, steps, allowed, controller.signal)
    if (!res.ok) throw new Error(res.errors.join(';'))
    expect(res.state.completed).toEqual([])
    expect((await row(res.state.id)).status).toBe('paused')
  })

  it('执行途中从任务中心暂停：在下一个步骤之前生效，不被进度保存覆盖', async () => {
    let planId = ''
    // 第二次检查时（n1 已完成）模拟另一个请求写入暂停
    const signal = abortOnCheck(2, () => {
      void db.update(schema.plans).set({ status: 'paused' }).where(eq(schema.plans.userId, userId)).then(() => {})
    })
    const res = await startPlan(ctx, steps, allowed, signal)
    if (!res.ok) throw new Error(res.errors.join(';'))
    planId = res.state.id
    expect(res.state.status).toBe('paused')
    expect(res.state.completed).toEqual(['n1'])
    expect((await row(planId)).status).toBe('paused')
  })

  it('停止后的计划可以恢复并从断点完成', async () => {
    const res = await startPlan(ctx, steps, allowed, abortOnCheck(2))
    if (!res.ok) throw new Error(res.errors.join(';'))
    const resumed = await controlPlan(ctx, res.state.id, 'resume')
    expect(resumed.status).toBe('completed')
    expect(resumed.completed).toEqual(['n1', 'n2', 'n3'])
  })

  it('对执行中的计划暂停立即生效，读取时以暂停为准', async () => {
    const id = 'plan_interrupt_inflight'
    const running = initPlanState(id, steps as Plan)
    await db.insert(schema.plans).values({ id, userId, sessionId: ctx.sessionId, stateJson: JSON.stringify(running), status: 'running', updatedAt: new Date() })
    expect((await controlPlan(ctx, id, 'pause')).status).toBe('paused')
    expect((await row(id)).status).toBe('paused')
    expect((await controlPlan(ctx, id, 'resume')).status).toBe('completed')
  })

  it('他人不能暂停不属于自己的计划', async () => {
    const res = await startPlan(ctx, steps, allowed, abortOnCheck(2))
    if (!res.ok) throw new Error(res.errors.join(';'))
    await db.update(schema.plans).set({ status: 'running' }).where(eq(schema.plans.id, res.state.id))
    await expect(controlPlan({ ...ctx, userId: 'someone_else' }, res.state.id, 'pause')).rejects.toThrow()
    expect((await row(res.state.id)).status).toBe('running')
  })
})
