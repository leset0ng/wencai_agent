import { audit } from '#/server/audit/log'
import { guard } from '#/server/guard'
import type { AgentContext } from '#/server/agent/context'
import { UNTRUSTED_FIELDS } from './define'

export const REDACTED = '[已屏蔽可疑内容]'

/**
 * 间接注入防护：工具输出中外部可控字段过 Guard，可疑内容替换为占位符并审计。
 * 返回新对象，不修改原值。
 */
export async function sanitizeToolOutput<T>(ctx: AgentContext, tool: string, value: T): Promise<T> {
  const visit = async (v: unknown, key?: string): Promise<unknown> => {
    if (typeof v === 'string' && key && UNTRUSTED_FIELDS.has(key)) {
      const verdict = await guard.check(v, 'tool_output')
      if (verdict.verdict === 'allow') return v
      await audit(ctx, 'injection_redacted', { tool, field: key, verdict, sample: v.slice(0, 200) })
      return REDACTED
    }
    if (Array.isArray(v)) return Promise.all(v.map((x) => visit(x)))
    if (v && typeof v === 'object') {
      const entries = await Promise.all(
        Object.entries(v).map(async ([k, x]) => [k, await visit(x, k)] as const),
      )
      return Object.fromEntries(entries)
    }
    return v
  }
  return (await visit(value)) as T
}

/** 给模型看的版本：外部文本加隔离标记，提示其只作数据处理 */
export function quarantineForModel(value: unknown): unknown {
  const visit = (v: unknown, key?: string): unknown => {
    if (typeof v === 'string' && key && UNTRUSTED_FIELDS.has(key)) return `⟦外部文本⟧${v.replaceAll('⟦', '［').replaceAll('⟧', '］')}⟦/外部文本⟧`
    if (Array.isArray(v)) return v.map((x) => visit(x))
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, visit(x, k)]))
    }
    return v
  }
  return visit(value)
}
