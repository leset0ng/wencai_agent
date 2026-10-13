import { describe, expect, it } from 'vitest'
import { decide } from '#/server/policy/engine'
import type { PolicyFacts, PolicyInput } from '#/server/policy/types'

const facts = (over: Partial<PolicyFacts> = {}): PolicyFacts => ({
  now: new Date('2026-10-10T14:00:00'),
  channel: 'web',
  accountLocked: false,
  dailyOutgoingCents: 0,
  payeeAgeDays: 400,
  recentTransferCount: 0,
  ...over,
})
const transfer = (amount: number, f: Partial<PolicyFacts> = {}): PolicyInput => ({
  tool: 'transfer',
  baseRisk: 'yellow',
  args: { amount },
  facts: facts(f),
})

describe('权限分级', () => {
  it.each(['transfer_between_cards', 'repay_credit_card'])('%s 复用金额与频率风控，本人操作不误判新收款人', (tool) => {
    const input = { tool, baseRisk: 'yellow' as const, args: { amountCents: 50_000 }, facts: facts({ payeeAgeDays: undefined }) }
    expect(decide(input)).toMatchObject({ allowed: true, level: 'yellow' })
    expect(decide({ ...input, args: { amountCents: 300_001 } }).level).toBe('red')
    expect(decide({ ...input, facts: facts({ recentTransferCount: 5 }) }).allowed).toBe(false)
  })
  it('只读操作为绿色', () => {
    expect(decide({ tool: 'get_accounts', baseRisk: 'green', args: {}, facts: facts() }).level).toBe('green')
  })

  it('小额转账给老收款人为黄色', () => {
    const d = decide(transfer(200))
    expect(d).toMatchObject({ level: 'yellow', allowed: true })
  })

  it('单笔超过 3000 元升级为红色，累计不影响单笔边界', () => {
    expect(decide(transfer(3000.01)).level).toBe('red')
    expect(decide(transfer(300, { dailyOutgoingCents: 800_000 })).level).toBe('yellow')
    expect(decide(transfer(3000)).level).toBe('yellow')
  })

  it('未标记异常的新收款人不强制双重验证', () => {
    expect(decide(transfer(10, { payeeAgeDays: 2 })).level).toBe('yellow')
    expect(decide(transfer(10, { payeeAgeDays: undefined })).level).toBe('yellow')
  })

  it('夜间普通交易仍可单方式验证', () => {
    expect(decide(transfer(600, { now: new Date('2026-10-10T03:00:00') })).level).toBe('yellow')
  })

  it('规则只升不降：模型无法通过参数降低等级', () => {
    const d = decide({ tool: 'report_card_lost', baseRisk: 'red', args: { level: 'green', amount: 0 }, facts: facts() })
    expect(d.level).toBe('red')
  })

  it('账户锁定时拒绝写操作，但允许查询', () => {
    expect(decide(transfer(10, { accountLocked: true })).allowed).toBe(false)
    expect(decide({ tool: 'get_accounts', baseRisk: 'green', args: {}, facts: facts({ accountLocked: true }) }).allowed).toBe(true)
  })

  it('高频转账触发熔断', () => {
    expect(decide(transfer(10, { recentTransferCount: 5 })).allowed).toBe(false)
  })

  it('渠道能力上限：飞书红色操作需跳转 H5，MCP 黄色即需跳转', () => {
    expect(decide(transfer(5000, { channel: 'lark' })).requiresChannelHandoff).toBe(true)
    expect(decide(transfer(200, { channel: 'lark' })).requiresChannelHandoff).toBe(false)
    expect(decide(transfer(200, { channel: 'mcp' })).requiresChannelHandoff).toBe(true)
  })

  it('命中规则写入 reasons', () => {
    const d = decide(transfer(3001, { payeeRiskFlag: 'suspected' }))
    expect(d.reasons).toHaveLength(2)
  })
})
