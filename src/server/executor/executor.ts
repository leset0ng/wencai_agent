import { isRef } from '#/server/planner/dag'
import type { Plan, PlanNode } from '#/server/planner/dag'
import type { ToolOutcome } from '#/server/tools/define'

export type NodeStatus = 'pending' | 'done' | 'suspended' | 'failed' | 'compensated' | 'skipped' | 'handoff'

export interface NodeState {
  status: NodeStatus
  output?: unknown
  actionId?: string
  error?: string
}

export type PlanStatus = 'running' | 'suspended' | 'paused' | 'completed' | 'failed' | 'compensated' | 'handoff'

/** 可序列化的计划状态，挂起时整体持久化，确认后据此恢复 */
export interface PlanState {
  id: string
  plan: Plan
  status: PlanStatus
  nodes: Record<string, NodeState>
  /** 已完成节点的完成顺序，补偿时逆序执行 */
  completed: string[]
  manualReview?: { note: string; at: string }
}

/** 执行器与工具层的边界，便于用假实现做单测 */
export interface NodeRunner {
  run(node: PlanNode, args: Record<string, unknown>): Promise<ToolOutcome>
  compensate(node: PlanNode, args: Record<string, unknown>, output: unknown): Promise<boolean>
}

export interface AdvanceHooks {
  /** 每个节点执行前询问；返回 true 时计划停在当前位置并标记为 paused，已完成的节点保留 */
  shouldPause?: () => boolean | Promise<boolean>
  /** 每个节点得到结果后调用，用于保存进度 */
  onProgress?: (state: PlanState) => void | Promise<void>
}

export function initPlanState(id: string, plan: Plan): PlanState {
  return {
    id,
    plan,
    status: 'running',
    nodes: Object.fromEntries(plan.nodes.map((n) => [n.id, { status: 'pending' as const }])),
    completed: [],
  }
}

/**
 * 推进计划：按依赖就绪顺序执行；遇到需确认的节点挂起该分支，其余独立分支继续；
 * 任一节点失败/被拒，逆序补偿已完成的写操作并终止。
 * 暂停只发生在两个节点之间：正在执行的节点不会被打断，避免留下半完成的操作。
 */
export async function advance(state: PlanState, runner: NodeRunner, hooks: AdvanceHooks = {}): Promise<PlanState> {
  const s = structuredClone(state)
  const byId = new Map(s.plan.nodes.map((n) => [n.id, n]))

  for (;;) {
    const ready = s.plan.nodes.filter(
      (n) => s.nodes[n.id].status === 'pending' && n.dependsOn.every((d) => s.nodes[d].status === 'done'),
    )
    if (ready.length === 0) break

    for (const node of ready) {
      if (await hooks.shouldPause?.()) {
        s.status = 'paused'
        return s
      }
      if (node.kind === 'handoff') {
        s.nodes[node.id] = { status: 'handoff' }
        s.status = 'handoff'
        return s
      }
      const args = resolveArgs(node.args, s)
      const outcome = await runner.run(node, args)
      switch (outcome.status) {
        case 'done':
          s.nodes[node.id] = { status: 'done', output: outcome.data }
          s.completed.push(node.id)
          break
        case 'needs_confirmation':
        case 'needs_handoff':
          s.nodes[node.id] = { status: 'suspended', actionId: outcome.actionId, output: outcome }
          break
        case 'denied':
          return rollback(s, node.id, outcome.reasons.join('；'), byId, runner)
        case 'error':
          return rollback(s, node.id, outcome.message, byId, runner)
      }
      await hooks.onProgress?.(s)
    }
  }

  const statuses = Object.values(s.nodes).map((n) => n.status)
  s.status = statuses.includes('suspended') ? 'suspended' : statuses.every((st) => st === 'done') ? 'completed' : s.status
  return s
}

/** 用户确认后恢复：把挂起节点标记为完成，继续推进 */
export function resume(state: PlanState, nodeId: string, output: unknown, runner: NodeRunner): Promise<PlanState> {
  const s = structuredClone(state)
  if (s.nodes[nodeId]?.status !== 'suspended') throw new Error(`节点 ${nodeId} 未处于挂起状态`)
  s.nodes[nodeId] = { status: 'done', output }
  s.completed.push(nodeId)
  s.status = 'running'
  return advance(s, runner)
}

/** 用户拒绝确认：视为该节点失败，触发补偿 */
export function reject(state: PlanState, nodeId: string, runner: NodeRunner): Promise<PlanState> {
  const byId = new Map(state.plan.nodes.map((n) => [n.id, n]))
  return rollback(structuredClone(state), nodeId, '用户取消', byId, runner)
}

async function rollback(
  s: PlanState,
  failedId: string,
  error: string,
  byId: Map<string, PlanNode>,
  runner: NodeRunner,
): Promise<PlanState> {
  s.nodes[failedId] = { ...s.nodes[failedId], status: 'failed', error }
  let allCompensated = true
  for (const id of [...s.completed].reverse()) {
    const node = byId.get(id)!
    const ok = await runner.compensate(node, resolveArgs(node.args, s), s.nodes[id].output).catch(() => false)
    if (ok) s.nodes[id].status = 'compensated'
    else allCompensated = false
  }
  for (const n of s.plan.nodes) if (s.nodes[n.id].status === 'pending') s.nodes[n.id].status = 'skipped'
  s.status = allCompensated ? 'compensated' : 'failed'
  return s
}

function resolveArgs(args: Record<string, unknown>, s: PlanState): Record<string, unknown> {
  const visit = (v: unknown): unknown => {
    if (isRef(v)) {
      const [nodeId, ...path] = v.$ref.split('.')
      let cur: unknown = s.nodes[nodeId]?.output
      for (const key of path) cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[key] : undefined
      return cur
    }
    if (Array.isArray(v)) return v.map(visit)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, visit(x)]))
    return v
  }
  return visit(args) as Record<string, unknown>
}
