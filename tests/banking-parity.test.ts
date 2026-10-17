import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfirmCardProps } from '#/components/chat/ConfirmCard'
import type { DashboardData } from '#/lib/dashboard'
import { AccountMonthlyTotals, AssetDetails, NotificationDetails, SubscriptionList } from '#/components/banking/BankingHome'
import { PaymentApproval } from '#/components/banking/PaymentCenter'
import { Route as RegisterRoute } from '#/routes/register'
import { AuthPage } from '#/components/banking/AuthPage'

const captured = vi.hoisted(() => ({ props: undefined as ConfirmCardProps | undefined, mutate: vi.fn() }))
vi.mock('#/components/chat/ChatView', () => ({ default: () => null }))
vi.mock('#/components/chat/ConfirmCard', () => ({ default: (props: ConfirmCardProps) => { captured.props = props; return null } }))
vi.mock('#/lib/queries', async (original) => ({
  ...await original<typeof import('#/lib/queries')>(),
  useConfirmAction: () => ({ error: null, isPending: false, mutateAsync: captured.mutate }),
  useCancelAction: () => ({ error: null, isPending: false, mutateAsync: vi.fn() }),
}))

const monthly: DashboardData['monthly'] = { period: '2026-10', income: 1234.56, expense: 789.01, categories: [] }
const subscriptions: DashboardData['subscriptions'] = [
  { id: 'monthly', merchant: '月订阅', amount: 88.12, cycle: 'monthly', status: 'active' },
  { id: 'yearly', merchant: '年订阅', amount: 456.78, cycle: 'yearly', status: 'paused' },
]
const dashboard: DashboardData = {
  now: '2026-10-14T06:00:00Z', totalAssets: 1200, availableBalance: 800, investmentPrincipal: 300, reservedBalance: 100,
  accounts: [{ id: 'a', name: '储蓄账户', balance: 900, currency: 'CNY' }], cards: [], accountActivity: {}, transactions: [],
  subscriptions, monthly, trend: [],
}

beforeEach(() => { captured.props = undefined; captured.mutate.mockClear() })

describe('银行首页 main 功能对齐', () => {
  it('单账户收入与支出遵守隐藏资产开关', () => {
    const visible = renderToStaticMarkup(createElement(AccountMonthlyTotals, { monthly, hidden: false }))
    expect(visible).toContain('+1,234.56')
    expect(visible).toContain('−789.01')
    const hidden = renderToStaticMarkup(createElement(AccountMonthlyTotals, { monthly, hidden: true }))
    expect(hidden).toContain('••••')
    expect(hidden).not.toMatch(/1,234\.56|789\.01/)
  })

  it('订阅保留每月/每年周期，隐藏时不泄露金额', () => {
    const visible = renderToStaticMarkup(createElement(SubscriptionList, { subscriptions, hidden: false }))
    expect(visible).toContain('每月')
    expect(visible).toContain('每年')
    expect(visible).toContain('88.12')
    expect(visible).toContain('456.78')
    const hidden = renderToStaticMarkup(createElement(SubscriptionList, { subscriptions, hidden: true }))
    expect(hidden).not.toMatch(/88\.12|456\.78/)
    expect(renderToStaticMarkup(createElement(SubscriptionList, { subscriptions: [], hidden: false }))).toContain('暂无订阅记录')
  })

  it('资产详情展示可用资金、理财本金和生日预留，且遮罩所有金额', () => {
    const visible = renderToStaticMarkup(createElement(AssetDetails, { data: dashboard, hidden: false }))
    for (const label of ['可用余额', '理财持仓本金', '生日计划预留资金', '不包含预计收益']) expect(visible).toContain(label)
    for (const amount of ['1,200.00', '800.00', '300.00', '100.00', '900.00']) expect(visible).toContain(amount)
    const hidden = renderToStaticMarkup(createElement(AssetDetails, { data: dashboard, hidden: true }))
    expect(hidden).toContain('••••')
    expect(hidden).not.toMatch(/1,200\.00|800\.00|300\.00|100\.00|900\.00/)
  })

  it('旧数据未提供预留金额时按零展示', () => {
    const { reservedBalance: _, ...legacy } = dashboard
    expect(renderToStaticMarkup(createElement(AssetDetails, { data: legacy, hidden: false }))).toContain('¥ 0.00')
  })

  it('消息展示正文和安全确认链接，订阅提醒仅展示生效记录', () => {
    const html = renderToStaticMarkup(createElement(NotificationDetails, {
      notifications: [{ id: 'notice', title: '待确认通知', body: '请核对转账摘要', actionId: 'action /?', read: false }],
      subscriptions, hidden: false, onManage: vi.fn(),
    }))
    expect(html).toContain('待确认通知')
    expect(html).toContain('请核对转账摘要')
    expect(html).toContain('href="/confirm/action%20%2F%3F"')
    expect(html).toContain('核对并确认')
    expect(html).toContain('月订阅')
    expect(html).not.toContain('年订阅')
    expect(html).toContain('管理订阅提醒')
  })

  it('空消息仍展示提醒管理，通知金额以外的订阅金额遵守遮罩', () => {
    const html = renderToStaticMarkup(createElement(NotificationDetails, { notifications: [], subscriptions, hidden: true, onManage: vi.fn() }))
    expect(html).toContain('暂无消息通知')
    expect(html).toContain('管理订阅提醒')
    expect(html).not.toContain('88.12')
  })

  it('/register 保留 fork 的独立注册界面入口', () => {
    const component = RegisterRoute.options.component as () => ReactElement<{ register: boolean }>
    const page = component()
    expect(page.type).toBe(AuthPage)
    expect(page.props.register).toBe(true)
  })

  it('安全页完成后把服务端回执传回付款流程，不重复发起确认 mutation', async () => {
    const onComplete = vi.fn()
    renderToStaticMarkup(createElement(PaymentApproval, {
      pending: { status: 'needs_confirmation', actionId: 'test', level: 'yellow', reasons: [], summary: { title: '转账', fields: [] }, expiresAt: Date.now() + 60_000 },
      onBack: vi.fn(), onComplete,
    }))
    const output = { transactionId: 'transaction', amount: 12.34 }
    expect(captured.props?.onCompleted).toBeTypeOf('function')
    await captured.props!.onCompleted!({ ok: true, output })
    expect(onComplete).toHaveBeenCalledExactlyOnceWith(output)
    expect(captured.mutate).not.toHaveBeenCalled()
  })
})
