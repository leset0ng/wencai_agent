import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { BANK_TOOLS } from '#/server/tools/bank'
import { availableBankTools } from '#/server/agent/tools'
import type { BankToolDef } from '#/server/tools/define'
const kinds = (tools: BankToolDef[]) => [tools.length, tools.filter(t=>t.kind==='read').length, tools.filter(t=>t.kind==='write').length]
it('README计数对应注册表及实际渠道白名单，没有自记AA到账入口', () => {
  const doc = readFileSync('README.md','utf8')
  const registry = doc.match(/注册表共 (\d+) 个工具（(\d+) 个 read、(\d+) 个 write）/)
  const agent = doc.match(/Agent 暴露 (\d+) 个（(\d+) 个 read、(\d+) 个 write）/)
  const mcp = doc.match(/MCP 只暴露 (\d+) 个只读工具/)
  expect(registry && agent && mcp).toBeTruthy()
  const ctx={userId:'catalog',sessionId:'catalog',channel:'web' as const}
  const mcpTools = availableBankTools({...ctx,channel:'mcp'})
  expect(registry!.slice(1).map(Number)).toEqual(kinds(BANK_TOOLS))
  expect(agent!.slice(1).map(Number)).toEqual(kinds(availableBankTools(ctx)))
  expect(Number(mcp![1])).toBe(mcpTools.length)
  expect(mcpTools.every(t=>t.kind==='read')).toBe(true)
  expect(BANK_TOOLS.some(t=>t.name==='settle_split')).toBe(false)
  expect(doc).not.toContain('扩展转账尚未接入')
})
