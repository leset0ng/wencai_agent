import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { BANK_TOOLS } from '#/server/tools/bank'
import { availableBankTools } from '#/server/agent/tools'
it('README计数对应注册表及实际渠道白名单，没有自记AA到账入口', () => {
  const doc = readFileSync('README.md','utf8')
  const counts = doc.match(/注册表共 (\d+) 个工具（(\d+) 个 read、(\d+) 个 write）/)
  expect(counts).not.toBeNull()
  expect(counts!.slice(1).map(Number)).toEqual([BANK_TOOLS.length,BANK_TOOLS.filter(t=>t.kind==='read').length,BANK_TOOLS.filter(t=>t.kind==='write').length])
  const ctx={userId:'catalog',sessionId:'catalog',channel:'web' as const}
  expect(availableBankTools(ctx)).toHaveLength(88)
  expect(availableBankTools({...ctx,channel:'mcp'}).every(t=>t.kind==='read')).toBe(true)
  expect(BANK_TOOLS.some(t=>t.name==='settle_split')).toBe(false)
  expect(doc).not.toContain('扩展转账尚未接入')
})
