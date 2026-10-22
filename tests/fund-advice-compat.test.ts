import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { AdviceCard } from '#/components/banking/FundPanel'

it('renders a saved expert result from before preference fields were introduced', () => {
  const previous = { status: 'advice', source: 'rule', summary: '旧版建议', budget: { monthlyExpenseCents: 10000, reserveCents: 60000, investableCents: 90000 }, conflicts: [], picks: [], disclaimer: '历史业绩不代表未来收益' }
  const data = previous as unknown as ComponentProps<typeof AdviceCard>['data']
  expect(renderToStaticMarkup(createElement(AdviceCard, { data }))).toContain('旧版建议')
})

it('formats the expert budget in yuan and preserves its textual risk rating', () => {
  const result = { status: 'advice', source: 'rule', summary: '建议', riskRating: 'R5', budget: { monthlyExpenseCents: 10000, reserveCents: 60000, investableCents: 900000, amountCents: 500000 }, conflicts: [], picks: [], disclaimer: '历史业绩不代表未来收益' }
  const html = renderToStaticMarkup(createElement(AdviceCard, { data: result as unknown as ComponentProps<typeof AdviceCard>['data'] }))
  expect(html).toContain('¥5,000.00')
  expect(html).toContain('你的风险等级 R5')
  expect(html).not.toContain('¥500,000.00')
})
