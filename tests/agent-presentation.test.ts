import { createElement, Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import ToolPart from '#/components/chat/ToolPart'
import type { ToolUIPart } from '#/components/chat/ToolPart'
import { toolPresentations } from '#/components/chat/presentation'
import type { WencaiUIMessage } from '#/server/agent/messages'

const report = (period = '2026-10', expense = 100) => ({ period, expense, categories: { 餐饮: 30, 交通: expense - 30 } })
const analysis = { days: 30, result: { totalSpent: 100, byCategory: [{ category: '交通', total: 70 }, { category: '餐饮', total: 30 }] } }
const done = (tool: string, data: unknown): ToolUIPart => ({ type: `tool-${tool}`, toolCallId: tool, state: 'output-available', output: { status: 'done', data } })
function view(tool = 'analyze_spending', data: unknown = analysis, type = 'PieChart'): ToolUIPart {
  return {
    type: 'tool-show_view', toolCallId: 'view', state: 'output-available',
    output: { status: 'view', spec: {
      root: 'chart', elements: { chart: { type, props: {
        title: '分类', data: { $state: `/${tool}/result/byCategory` }, labelKey: 'category', valueKey: 'total',
      }, children: [] } }, state: { [tool]: data },
    } },
  }
}
const parts = (items: ToolUIPart[]) => items as unknown as WencaiUIMessage['parts']
function html(items: ToolUIPart[], processing = false) {
  const modes = toolPresentations(parts(items), processing)
  return renderToStaticMarkup(createElement(Fragment, {}, ...items.map((part, i) => modes[i] === 'hidden' ? null :
    createElement(ToolPart, { key: i, part, summarized: modes[i] === 'status', onFollowUp: () => {} }))))
}

describe('Agent 只展示最终数据视图', () => {
  it('重复收款候选只展示一次，不同对象的查询保留各自选择', () => {
    const a = done('find_payee', { candidates: [{ id: 'mom', name: '妈妈' }] })
    const b = done('find_payee', { candidates: [{ id: 'dad', name: '爸爸' }] })
    expect(toolPresentations(parts([a, a]))).toEqual(['status', 'result'])
    expect(toolPresentations(parts([a, b]))).toEqual(['result', 'result'])
    expect(toolPresentations(parts([a]), true)).toEqual(['status'])
  })
  it('全部银行卡与关联储蓄账户的重叠查询只保留一个完整选卡区，独立账户不受影响', () => {
    const card = { id: 'c', last4: '8823', balance: 100 }, account = { id: 'a', cardId: 'c', last4: '8823', balance: 100 }
    const all = done('list_cards', [card, { id: 'credit', last4: '1047', availableCredit: 5000 }]), linked = done('get_accounts', [account])
    expect(toolPresentations(parts([all, linked]))).toEqual(['result', 'status'])
    expect(toolPresentations(parts([linked, all]))).toEqual(['status', 'result'])
    expect(toolPresentations(parts([all, done('get_accounts', [{ id: 'independent', balance: 100 }])]))).toEqual(['result', 'result'])
    expect(toolPresentations(parts([all, done('get_accounts', [{ ...account, balance: 90 }])]))).toEqual(['result', 'result'])
  })
  it('处理期间不挂载固定报表、账户卡片或已完成的生成式图表', () => {
    const items = [done('get_accounts', [{ id: 'a', name: '账户', balance: 100 }]), done('get_spending_report', report()), view()]
    expect(toolPresentations(parts(items), true)).toEqual(['status', 'status', 'status'])
    expect(html(items, true)).not.toMatch(/data-arc|bank-physical-card|bank-financial-report/)
    expect(html(items, true)).toContain('结果已整理')
  })
  it('跨查询、分析工具引用相同数据时仅保留最终图表', () => {
    const items = [done('get_spending_report', report()), done('analyze_spending', analysis), view()]
    expect(toolPresentations(parts(items))).toEqual(['status', 'status', 'result'])
    expect(html(items).match(/data-arc="true"/g)).toHaveLength(2)
    expect(html(items)).not.toContain('bank-financial-report')
  })
  it('没有生成视图时，重复查询的固定报表只展示一次', () => {
    const items = [done('get_spending_report', report()), done('analyze_spending', analysis)]
    expect(toolPresentations(parts(items))).toEqual(['status', 'result'])
    expect(html(items).match(/data-arc="true"/g)).toHaveLength(2)
  })
  it('同一账期重新查询得到新数据时仅保留最新固定结果；空报表也去重', () => {
    expect(toolPresentations(parts([done('get_spending_report', report()), done('get_spending_report', report('2026-10', 200))])))
      .toEqual(['status', 'result'])
    expect(toolPresentations(parts([done('get_spending_report', { period: '2026-10', expense: 0, categories: {} }),
      done('analyze_spending', { days: 30, result: { totalSpent: 0, byCategory: [] } })])))
      .toEqual(['status', 'result'])
  })
  it('视图生成失败时保留固定报表作为结果，不显示已被兜底的视图错误', () => {
    const failed: ToolUIPart = { type: 'tool-show_view', toolCallId: 'failed', state: 'output-error', errorText: 'An error occurred.' }
    const invalid: ToolUIPart = { ...failed, state: 'output-available', output: { status: 'invalid_view', errors: ['路径无效'] } }
    const items = [done('get_spending_report', report()), invalid, failed]
    expect(toolPresentations(parts(items))).toEqual(['result', 'hidden', 'hidden'])
    expect(html(items)).toContain('bank-financial-report')
    expect(html(items)).not.toMatch(/失败|An error/)
    expect(toolPresentations(parts([failed]))).toEqual(['result'])
  })
  it('视图重试成功后隐藏旧视图和失败尝试，保留后一次图表', () => {
    const failed: ToolUIPart = { type: 'tool-show_view', toolCallId: 'failed', state: 'output-error', errorText: 'error' }
    const items = [view(), failed, view('analyze_spending', analysis, 'BarChart')]
    expect(toolPresentations(parts(items))).toEqual(['hidden', 'hidden', 'result'])
    expect(html(items)).not.toContain('data-arc')
    expect(html(items).match(/data-bar="true"/g)).toHaveLength(2)
  })
  it('保留不同账期、不同滚动窗口的独立结果，即使金额碰巧相同', () => {
    const items = [done('get_spending_report', report('2026-09')), done('get_spending_report', report('2026-10'))]
    expect(toolPresentations(parts(items))).toEqual(['result', 'result'])
    expect(toolPresentations(parts([done('analyze_spending', analysis), done('analyze_spending', { ...analysis, days: 90 })])))
      .toEqual(['result', 'result'])
  })
  it('多图放在一个最终视图中时保持完整，不按图形类型删除组件', () => {
    const item = view()
    const out = item.output as { spec: { root: string; elements: Record<string, unknown> } }
    out.spec.elements.bar = { type: 'BarChart', props: { title: '分类金额', data: { $state: '/analyze_spending/result/byCategory' }, labelKey: 'category', valueKey: 'total' }, children: [] }
    out.spec.elements.panel = { type: 'Panel', props: { title: '分类分析', subtitle: null }, children: ['chart', 'bar'] }
    out.spec.root = 'panel'
    const markup = html([done('analyze_spending', analysis), item])
    expect(markup.match(/data-arc="true"/g)).toHaveLength(2)
    expect(markup.match(/data-bar="true"/g)).toHaveLength(2)
  })
  it('同一报表的收入与支出是不同结果视图，不能相互覆盖', () => {
    const items = ['income', 'expense'].map((field) => ({
      type: 'tool-show_view' as const, toolCallId: field, state: 'output-available' as const,
      output: { status: 'view', spec: {
        root: 'metric', state: { get_spending_report: { ...report(), income: 200 } },
        elements: { metric: { type: 'Metric', props: { label: field, value: { $state: `/get_spending_report/${field}` }, unit: '元' }, children: [] } },
      } },
    }))
    expect(toolPresentations(parts(items))).toEqual(['result', 'result'])
  })
  it('不让未挂载的孤立元素遮住真实报表', () => {
    const item = view()
    const out = item.output as { spec: { root: string; elements: Record<string, unknown> } }
    out.spec.elements.note = { type: 'Note', props: { text: '分析完成' }, children: [] }
    out.spec.root = 'note'
    expect(toolPresentations(parts([done('analyze_spending', analysis), item]))).toEqual(['result', 'result'])
  })
  it('确认、强验证、拒绝及银行业务错误不受最终视图折叠影响', () => {
    const protectedParts = ['needs_confirmation', 'needs_handoff', 'denied', 'error']
      .map((status) => ({ ...done('transfer', {}), output: { status } }))
    expect(toolPresentations(parts([...protectedParts, view()]), true)).toEqual(['result', 'result', 'result', 'result', 'status'])
    expect(toolPresentations(parts([...protectedParts, view()]))).toEqual(['result', 'result', 'result', 'result', 'result'])
    const failed = { ...done('get_accounts', {}), state: 'output-error' as const, errorText: '查询失败' }
    expect(html([failed, view()])).toContain('查询失败')
  })
  it('历史回答与新一轮处理分开计算，上一轮图表保持可见', () => {
    expect(html([view()], false)).toContain('data-arc')
    expect(html([done('get_spending_report', report())], true)).not.toContain('data-arc')
  })
})
