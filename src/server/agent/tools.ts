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
import { InteractionTemplateSchema } from '#/lib/agent-interaction-template'
import { checkInteractionTemplate } from '#/server/genui/interaction-template'
import { BatchTransferRequestSchema } from '#/lib/batch-transfer'
import { prepareTransferBatch } from './batch-transfer'
import { QuestionnaireSchema } from '#/lib/questionnaire'

/** 按渠道裁剪工具白名单：MCP 只暴露只读工具 */
export function availableBankTools(ctx: AgentContext): BankToolDef[] {
  const current = BANK_TOOLS.filter((tool) => tool.name !== 'request_password_change')
  return ctx.channel === 'mcp' ? current.filter((t) => t.kind === 'read') : current
}

/** 构建本次请求的 AI SDK 工具集。ctx 通过闭包注入，模型无法篡改身份。 */
export function buildAgentTools(ctx: AgentContext, options: { readOnly?: boolean; requestText?: string } = {}): ToolSet {
  const bankTools = availableBankTools(ctx).filter((tool) => !options.readOnly || tool.kind === 'read')
  const tools: ToolSet = {}
  const currentTools = new Set<string>()

  for (const def of bankTools) {
    tools[def.name] = tool({
      description: `${def.description}${def.kind === 'write' ? '（写操作，系统会按风险等级要求用户确认）' : ''}`,
      inputSchema: modelToolSchema(def.inputSchema),
      execute: async (args) => {
        const outcome = await runBankTool(def, args, ctx)
        if (outcome.status === 'done') {
          putSessionData(ctx.sessionId, def.name, outcome.data)
          currentTools.add(def.name)
        }
        return outcome
      },
      toModelOutput: ({ output }) => ({ type: 'json', value: quarantineForModel(output) as never }),
    })
  }

  if (ctx.channel !== 'mcp') {
    if (!options.readOnly) tools.ask_questions = tool({
      description: '为当前业务设计1至12道单选题，每题2至6个选项。逐题选择，最后提交才发送全部题目和答案，途中不发送。只收集业务偏好，不收集密码、验证码、完整卡号或身份证号。风险测评改用get_risk_questionnaire标准问卷，不改题或评分。答案不执行交易、不代替安全确认。',
      inputSchema: z.object({ questionnaire: QuestionnaireSchema }),
      execute: async ({ questionnaire }) => questionnaire.purpose === 'risk_assessment' || /风险.{0,4}(?:测评|评估|评定)/.test(questionnaire.title)
        ? { status: 'invalid_questionnaire' as const, errors: ['风险测评请使用get_risk_questionnaire标准问卷'] }
        : { status: 'questionnaire' as const, questionnaire },
      toModelOutput: ({ output }) => ({ type: 'json', value: output as never }),
    })
    tools.prepare_transfer_batch = tool({
      description: '为同一用户请求中的2至8笔转账准备一个可复用交互：逐笔填写原文中的收款人称呼和元金额，自动查询每笔独立收款候选及共用付款卡。支持“给妈妈转400再给王芳转200”。仅查询和准备界面，不生成交易、不执行、不代表验证通过。缺少参数时返回具体待补充项。',
      inputSchema: BatchTransferRequestSchema,
      execute: async (input) => {
        const result = await prepareTransferBatch(input, options.requestText ?? '', async (name, args) => {
          const def = bankTools.find((tool) => tool.name === name)!
          return runBankTool(def, args, ctx)
        })
        if (result.status === 'batch_transfer_ready') putSessionData(ctx.sessionId, 'prepare_transfer_batch', structuredClone(result))
        return result
      },
      toModelOutput: ({ output }) => ({ type: 'json', value: quarantineForModel(output) as never }),
    })
    tools.prepare_interaction = tool({
      description: '为当前选择界面声明一个稳定的语义消息模板；只描述当前一个办理步骤。确认按钮按模板和用户选择生成消息，不复制历史原文。不能授权、执行或声明安全验证通过。',
      inputSchema: InteractionTemplateSchema,
      execute: async (input) => {
        const check = checkInteractionTemplate(input, getSessionData(ctx.sessionId), options.requestText, currentTools)
        return check.ok
          ? { status: 'interaction_ready' as const, interaction: check.interaction }
          : { status: 'invalid_interaction' as const, errors: check.errors }
      },
      toModelOutput: ({ output }) => ({ type: 'json', value: output as never }),
    })
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
        const check = checkSpec(spec, state, options.requestText, currentTools)
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
