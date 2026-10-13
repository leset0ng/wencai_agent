import { describe, expect, it } from 'vitest'
import { buildAgentTools } from '#/server/agent/tools'
import { BANK_TOOLS } from '#/server/tools/bank'
import { StepUpSchema } from '#/server/auth/step-up'

const ctx = (channel: 'web' | 'lark' | 'mcp') => ({ userId: 'u_boundary', sessionId: 'boundary', channel })

/** 确认与强验证是独立链路：模型的工具集里不存在任何能放行或代替验证的入口。 */
describe('确认链路与模型隔离', () => {
  it.each(['web', 'lark', 'mcp'] as const)('%s 渠道的工具集中没有确认、放行或验证类工具', (channel) => {
    const names = Object.keys(buildAgentTools(ctx(channel)))
    expect(names.filter((name) => /confirm|approv|authori|step_?up|verify|passkey|sms/i.test(name))).toEqual([])
  })

  it('模型可调用的写工具基础等级都不是绿色，必须经过确认单', () => {
    const tools = buildAgentTools(ctx('web'))
    for (const def of BANK_TOOLS.filter((tool) => tool.kind === 'write')) {
      expect(tools).toHaveProperty(def.name)
      expect(def.baseRisk, def.name).not.toBe('green')
      expect(def.summarize, def.name).toBeTypeOf('function')
    }
  })

  it('MCP 渠道不暴露任何写工具和计划工具', () => {
    const tools = buildAgentTools(ctx('mcp'))
    for (const def of BANK_TOOLS.filter((tool) => tool.kind === 'write')) expect(tools).not.toHaveProperty(def.name)
    expect(tools).not.toHaveProperty('plan_task')
  })

  it('工具参数里没有用户身份和验证材料字段', () => {
    for (const def of BANK_TOOLS) {
      const shape = (def.inputSchema as unknown as { shape?: Record<string, unknown> }).shape ?? {}
      expect(Object.keys(shape).filter((key) => /^(userId|stepUp|passkey|smsCode|verificationCode)$/i.test(key)), def.name).toEqual([])
    }
  })

  it('强验证材料只接受短信与 Passkey 两种结构', () => {
    expect(StepUpSchema.safeParse({ method: 'sms', challengeId: 'sms_1', code: '123456' }).success).toBe(true)
    expect(StepUpSchema.safeParse({ method: 'sms', challengeId: 'sms_1', code: 'abc' }).success).toBe(false)
    expect(StepUpSchema.safeParse({ method: 'model', approved: true }).success).toBe(false)
  })
})
