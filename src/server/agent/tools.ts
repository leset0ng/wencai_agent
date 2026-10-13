import { tool } from 'ai'
import type { ToolSet } from 'ai'
import { z } from 'zod'
import { PlanSchema } from '#/server/planner/dag'
import { startPlan } from '#/server/executor/service'
import { checkSpec } from '#/server/genui/validate'
import { BANK_TOOLS } from '#/server/tools/bank'
import { runBankTool } from '#/server/tools/runner'
import { quarantineForModel } from '#/server/tools/sanitize'
import type { BankToolDef } from '#/server/tools/define'
import type { AgentContext } from './context'
import { getSessionData, putSessionData } from './session'
import { modelToolSchema } from './tool-schema'

/** 按渠道裁剪工具白名单：MCP 只暴露只读工具 */
export function availableBankTools(ctx: AgentContext): BankToolDef[] {
  return ctx.channel === 'mcp' ? BANK_TOOLS.filter((t) => t.kind === 'read') : BANK_TOOLS
}

/** 构建本次请求的 AI SDK 工具集。ctx 通过闭包注入，模型无法篡改身份。 */
export function buildAgentTools(ctx: AgentContext, options: { readOnly?: boolean } = {}): ToolSet {
  const bankTools = availableBankTools(ctx).filter((tool) => !options.readOnly || tool.kind === 'read')
  const tools: ToolSet = {}

  for (const def of bankTools) {
    tools[def.name] = tool({
      description: `${def.description}${def.kind === 'write' ? '（写操作，系统会按风险等级要求用户确认）' : ''}`,
      inputSchema: modelToolSchema(def.inputSchema),
      execute: async (args) => {
        const outcome = await runBankTool(def, args, ctx)
        if (outcome.status === 'done') putSessionData(ctx.sessionId, def.name, outcome.data)
        return outcome
      },
      toModelOutput: ({ output }) => ({ type: 'json', value: quarantineForModel(output) as never }),
    })
  }

  if (ctx.channel !== 'mcp') {
    const allowed = new Set(bankTools.map((t) => t.name))
    if (!options.readOnly) tools.plan_task = tool({
      description:
        '提交多步骤任务计划（DAG）。系统会校验并按依赖执行，遇到需确认的步骤会挂起等待用户确认，失败时自动回滚已完成的写操作。' +
        '需要人工介入时使用 kind="handoff" 节点。',
      inputSchema: PlanSchema,
      execute: async (plan, { abortSignal }) => {
        // 用户按下停止时，计划停在当前步骤并保留为"已暂停"，不再创建后续确认单
        const res = await startPlan(ctx, plan, allowed, abortSignal)
        if (!res.ok) return { status: 'invalid_plan' as const, errors: res.errors }
        return { status: 'plan' as const, planId: res.state.id, state: res.state }
      },
      toModelOutput: ({ output }) => ({ type: 'json', value: quarantineForModel(output) as never }),
    })

    tools.show_view = tool({
      description: '用组件目录渲染一个展示类界面（看板、对比、明细）。数据必须用 $state 引用已调用工具的结果。',
      inputSchema: z.object({ spec: z.record(z.string(), z.unknown()) }),
      execute: async ({ spec }) => {
        const state = getSessionData(ctx.sessionId)
        const check = checkSpec(spec, state)
        if (!check.ok) return { status: 'invalid_view' as const, errors: check.errors }
        return { status: 'view' as const, spec: { ...check.spec, state: structuredClone(state) } }
      },
      // 模型只需知道是否渲染成功，无需回看整份数据
      toModelOutput: ({ output }) => ({
        type: 'json',
        value: output.status === 'view' ? { status: 'view_rendered' } : (output as never),
      }),
    })
  }

  return tools
}
