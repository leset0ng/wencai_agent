import { describe, expect, it } from 'vitest'
import { checkSpec } from '#/server/genui/validate'

const state = { analyze_spending: { result: { totalSpent: 3120.5, byCategory: [{ category: '餐饮', total: 1200 }] } } }

const spec = (elements: Record<string, unknown>) => ({ root: 'p', elements: { p: { type: 'Panel', props: { title: '本月账单', subtitle: null }, children: Object.keys(elements) }, ...elements } })

describe('生成式 UI 校验', () => {
  it('合法 spec 通过', () => {
    const r = checkSpec(
      spec({
        m: { type: 'Metric', props: { label: '总支出', value: { $state: '/analyze_spending/result/totalSpent' }, unit: '元' } },
        c: { type: 'PieChart', props: { title: '构成', data: { $state: '/analyze_spending/result/byCategory' }, labelKey: 'category', valueKey: 'total' } },
      }),
      state,
    )
    expect(r.ok).toBe(true)
  })

  it('数据 props 写数字字面量被拒绝（无法编造金额）', () => {
    const r = checkSpec(spec({ m: { type: 'Metric', props: { label: '总支出', value: 99999, unit: '元' } } }), state)
    expect(r.ok).toBe(false)
  })

  it('引用不存在的数据路径被拒绝', () => {
    const r = checkSpec(spec({ m: { type: 'Metric', props: { label: '余额', value: { $state: '/get_accounts/0/balance' }, unit: '元' } } }), state)
    expect(r.ok).toBe(false)
  })

  it('分金额不能当元展示，风险字符串和空指标不能显示成0', () => {
    const values = { result: { amountCents: 500000, riskRating: 'R5', sharpe: null } }
    for (const [field, unit] of [['amountCents', '元'], ['riskRating', null], ['sharpe', null]] as const) {
      expect(checkSpec(spec({ m: { type: 'Metric', props: { label: '指标', value: { $state: `/result/${field}` }, unit } } }), values).ok).toBe(false)
    }
  })

  it('理财专家结果沿用固定建议卡，不允许生成第二张可能错误的摘要', () => {
    const r = checkSpec(spec({ m: { type: 'Metric', props: { label: '可投', value: { $state: '/get_wealth_advice/budget/amountCents' }, unit: '元' } } }), { get_wealth_advice: { budget: { amountCents: 500000 } } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join(' ')).toContain('固定建议卡')
  })

  it('文本中夹带无出处金额被拒绝', () => {
    const r = checkSpec(spec({ n: { type: 'Note', props: { text: '您还有 ¥88,888 的额度可用' } } }), state)
    expect(r.ok).toBe(false)
  })

  it('未知组件被拒绝', () => {
    const r = checkSpec(spec({ x: { type: 'TransferButton', props: {} } }), state)
    expect(r.ok).toBe(false)
  })

  it('模型自带的 state 被丢弃，不能伪造数据', () => {
    const r = checkSpec(
      { ...spec({ m: { type: 'Metric', props: { label: '余额', value: { $state: '/fake/balance' }, unit: '元' } } }), state: { fake: { balance: 1e9 } } },
      state,
    )
    expect(r.ok).toBe(false)
  })
})
