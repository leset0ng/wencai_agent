import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSONUIProvider, Renderer } from '@json-render/react'
import type { Spec } from '@json-render/core'
import { AnimatedBarChart, AnimatedDonutChart, normalizeChartData } from '#/components/ui/charts'
import ToolPart from '#/components/chat/ToolPart'
import { registry } from '#/genui/registry'
import { checkSpec } from '#/server/genui/validate'

describe('可复用数据视图', () => {
  it('过滤无法绘制的图表数据，保留零值与实际金额', () => {
    expect(
      normalizeChartData(
        [
          { name: '餐饮', amount: 12.34 },
          { name: '购物', amount: '56.78' },
          { name: '空', amount: 0 },
          { name: '错误', amount: -5 },
          { name: '溢出', amount: Infinity },
          null,
          { amount: 9 },
        ],
        'name',
        'amount',
      ),
    ).toEqual([
      { label: '餐饮', value: 12.34 },
      { label: '购物', value: 56.78 },
      { label: '空', value: 0 },
    ])
    expect(normalizeChartData(undefined, 'name', 'amount')).toEqual([])
    expect(
      normalizeChartData(
        [
          { name: '空', amount: null },
          { name: '开关', amount: true },
          { name: '空白', amount: ' ' },
        ],
        'name',
        'amount',
      ),
    ).toEqual([])
  })
  it('空数据展示空状态，不生成错误弧线或伪造分类', () => {
    const data = [{ label: '餐饮', value: 0 }]
    expect(renderToStaticMarkup(createElement(AnimatedBarChart, { data }))).toContain(
      '暂无支出数据',
    )
    const ring = renderToStaticMarkup(createElement(AnimatedDonutChart, { data }))
    expect(ring).toContain('暂无分类数据')
    expect(ring).not.toContain('data-arc')
  })
  it('生成式图表解析经过校验的工具 state，复用纵向柱图和环图', () => {
    const state = {
      analyze_spending: {
        result: {
          byCategory: [
            { category: '餐饮', total: 30 },
            { category: '交通', total: 70 },
          ],
        },
      },
    }
    const checked = checkSpec(
      {
        root: 'panel',
        elements: {
          panel: {
            type: 'Panel',
            props: { title: '账单', subtitle: null },
            children: ['bar', 'pie'],
          },
          bar: {
            type: 'BarChart',
            props: {
              title: '分类支出',
              data: { $state: '/analyze_spending/result/byCategory' },
              labelKey: 'category',
              valueKey: 'total',
            },
          },
          pie: {
            type: 'PieChart',
            props: {
              title: '分类占比',
              data: { $state: '/analyze_spending/result/byCategory' },
              labelKey: 'category',
              valueKey: 'total',
            },
          },
        },
      },
      state,
    )
    expect(checked.ok).toBe(true)
    if (!checked.ok) return
    const html = renderToStaticMarkup(
      createElement(JSONUIProvider, {
        registry,
        initialState: state,
        children: createElement(Renderer, { spec: checked.spec as unknown as Spec, registry }),
      }),
    )
    expect(html.match(/data-bar="true"/g)).toHaveLength(2)
    expect(html.match(/data-arc="true"/g)).toHaveLength(2)
    expect(html).toContain('餐饮：30.0%，30.00元')
    expect(html).toContain('交通：70.00元')
    expect(html).not.toContain('NaN')
  })
  it('Agent 固定报表直接渲染工具金额和共享图表，未关联卡片的账户保留余额与选择入口', () => {
    const report = renderToStaticMarkup(
      createElement(ToolPart, {
        part: {
          type: 'tool-get_spending_report',
          toolCallId: 'report',
          state: 'output-available',
          output: {
            status: 'done',
            data: { period: '2026-01', expense: 100, categories: { 餐饮: 30, 交通: 70 } },
          },
        },
        onFollowUp: () => {},
      }),
    )
    expect(report).toContain('¥ 100.00')
    expect(report.match(/data-arc="true"/g)).toHaveLength(2)
    expect(report).toContain('柱状图')
    const account = renderToStaticMarkup(
      createElement(ToolPart, {
        part: {
          type: 'tool-get_accounts',
          toolCallId: 'accounts',
          state: 'output-available',
          output: { status: 'done', data: [{ id: 'a', name: '工资账户', balance: 123.45 }] },
        },
        onFollowUp: () => {},
      }),
    )
    expect(account).toContain('工资账户')
    expect(account).toContain('选择工资账户')
    expect(account).not.toContain('bank-physical-card')
    expect(account).toContain('¥ 123.45')
  })
})
