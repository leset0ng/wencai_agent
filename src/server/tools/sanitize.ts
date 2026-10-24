import { audit } from '#/server/audit/log'
import { guard } from '#/server/guard'
import type { AgentContext } from '#/server/agent/context'
import type { GuardVerdict } from '#/server/guard'
import { UNTRUSTED_FIELDS } from './define'
import type { CatalogField } from './define'

export const REDACTED = '[已屏蔽可疑内容]'

const untrusted = (key: string | undefined, catalog: readonly CatalogField[]) =>
  key !== undefined && UNTRUSTED_FIELDS.has(key) && !(catalog as readonly string[]).includes(key)

/**
 * 间接注入防护：工具输出中外部可控字段过 Guard，可疑内容替换为占位符并审计。
 * 返回新对象，不修改原值。同一次输出中重复的文本只审核一次。
 */
export async function sanitizeToolOutput<T>(ctx: AgentContext, tool: string, value: T, catalog: readonly CatalogField[] = []): Promise<T> {
  const verdicts = new Map<string, Promise<GuardVerdict>>()
  const check = (text: string) => {
    let verdict = verdicts.get(text)
    if (!verdict) verdicts.set(text, verdict = guard.check(text, 'tool_output'))
    return verdict
  }
  const visit = async (v: unknown, key?: string): Promise<unknown> => {
    if (typeof v === 'string' && untrusted(key, catalog)) {
      const verdict = await check(v)
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
export function quarantineForModel(value: unknown, catalog: readonly CatalogField[] = []): unknown {
  const visit = (v: unknown, key?: string): unknown => {
    if (typeof v === 'string' && untrusted(key, catalog)) return `⟦外部文本⟧${v.replaceAll('⟦', '［').replaceAll('⟧', '］')}⟦/外部文本⟧`
    if (Array.isArray(v)) return v.map((x) => visit(x))
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, visit(x, k)]))
    }
    return v
  }
  return visit(value)
}
