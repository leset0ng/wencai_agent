import type { z } from 'zod'
import type { AgentContext } from '#/server/agent/context'
import type { RiskLevel } from '#/server/policy/types'

/** 展示在确认卡上的摘要，由服务端根据已校验参数生成，不使用模型文字 */
export interface ConfirmSummary {
  title: string
  fields: { label: string; value: string }[]
}

export interface BankToolDef<I = any, O = any> {
  name: string
  description: string
  baseRisk: RiskLevel
  kind: 'read' | 'write'
  inputSchema: z.ZodType<I>
  /** 服务端解析卡片别名，确认前冻结实际身份；客户端不可提供这些派生字段。 */
  prepare?: (args: I, ctx: AgentContext) => Promise<I>
  /** 采集策略事实时需要的对象定位信息 */
  factsHint?: (args: I) => { payeeId?: string; toAccountId?: string; splitRequestId?: string }
  /** 写操作必须提供确认摘要 */
  summarize?: (args: I, ctx: AgentContext) => Promise<ConfirmSummary>
  execute: (args: I, ctx: AgentContext) => Promise<O>
  /** 补偿动作（Saga 回滚），DAG 失败时逆序调用 */
  compensate?: (args: I, output: O, ctx: AgentContext) => Promise<void>
}

export function defineBankTool<I, O>(def: BankToolDef<I, O>): BankToolDef<I, O> {
  if (def.kind === 'write' && !def.summarize) {
    throw new Error(`write tool ${def.name} must provide summarize()`)
  }
  return def
}

/** 工具统一返回结构：UI 依据 status 渲染固定组件 */
export type ToolOutcome =
  | { status: 'done'; data: unknown }
  | { status: 'denied'; reasons: string[] }
  | {
      status: 'needs_confirmation'
      actionId: string
      level: 'yellow' | 'red'
      reasons: string[]
      summary: ConfirmSummary
      expiresAt: number
    }
  | {
      status: 'needs_handoff'
      actionId: string
      level: 'yellow' | 'red'
      reasons: string[]
      summary: ConfirmSummary
      /** 跳转至 H5 完成强验证的一次性链接 */
      url: string
    }
  | { status: 'error'; message: string }

/** 外部可控的自由文本字段：交易对手、备注、商户名 */
export const UNTRUSTED_FIELDS = new Set(['counterparty', 'memo', 'merchant', 'description', 'remark', 'accountName', 'recipient', 'address', 'refundReason'])
