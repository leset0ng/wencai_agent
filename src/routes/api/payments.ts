import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { requireSession, UnauthorizedError } from '#/server/session'
import { listPaymentPayees, paymentAccounts } from '#/server/payments/service'
import { resolveTool } from '#/server/tools/bank'
import { runBankTool } from '#/server/tools/runner'
import { listLifeOrders, listLifeSubscriptions } from '#/server/life/service'
import { simNow } from '#/server/tools/jobs'
import { listFunds, fundDetails } from '#/server/funds/store'
import { fundPortfolio } from '#/server/funds/trading'
import { fundMetrics } from '#/server/funds/metrics'
import { MarketQuery, getWealthMarket, getFundAnalytics, setFundWatchlist } from '#/server/funds/market'
import { audit } from '#/server/audit/log'

const bodySchema = z.object({
  tool: z.enum(['search_bank_accounts', 'add_payee', 'transfer', 'transfer_between_accounts', 'transfer_between_cards', 'repay_credit_card', 'set_card_remark', 'lock_card', 'unlock_card', 'report_card_lost', 'adjust_card_limit', 'apply_card', 'adjust_credit_limit', 'cancel_subscription', 'buy_life_product', 'return_life_order', 'subscribe_life_service', 'preview_fund_order', 'commit_fund_order']),
  args: z.record(z.string(), z.unknown()),
})
// A user-clicked display preference, not a model-callable banking write tool.
const postSchema = z.union([bodySchema, z.object({ preference: z.literal('fund_watchlist'), code: z.string().regex(/^\d{6}$/), favorite: z.boolean() })])

export const Route = createFileRoute('/api/payments')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const session = await requireSession(request)
          if (new URL(request.url).searchParams.get('view') === 'wealth') {
            const params = new URL(request.url).searchParams, now = await simNow(), code = params.get('code')
            return Response.json(code ? await getFundAnalytics(code, now) : await getWealthMarket(session.userId, MarketQuery.parse(Object.fromEntries([...params].filter(([key]) => key !== 'view'))), now), { headers: { 'cache-control': 'no-store' } })
          }
          if (new URL(request.url).searchParams.get('view') === 'funds') {
            const now = await simNow(), code = new URL(request.url).searchParams.get('code')
            if (code) {
              const detail = await fundDetails(code, now)
              return Response.json({ ...detail, metrics: fundMetrics(detail.navs) }, { headers: { 'cache-control': 'no-store' } })
            }
            const [funds, portfolio] = await Promise.all([listFunds(now), fundPortfolio(session.userId, now)])
            return Response.json({ funds, portfolio }, { headers: { 'cache-control': 'no-store' } })
          }
          if(new URL(request.url).searchParams.get('view')==='life') {
            const now=await simNow()
            const [orders,subscriptions]=await Promise.all([listLifeOrders(session.userId,now),listLifeSubscriptions(session.userId,now)])
            return Response.json({orders,subscriptions,serverNow:now.toISOString()},{headers:{'cache-control':'no-store'}})
          }
          const [accounts, payees] = await Promise.all([
            paymentAccounts(session.userId),
            listPaymentPayees(session.userId),
          ])
          return Response.json({ accounts, payees }, { headers: { 'cache-control': 'no-store' } })
        } catch (e) {
          return failure(e)
        }
      },
      POST: async ({ request }) => {
        try {
          const session = await requireSession(request)
          const body = postSchema.parse(await request.json())
          if ('preference' in body) {
            const data = await setFundWatchlist(session.userId, body.code, body.favorite)
            await audit({ userId: session.userId, sessionId: session.sessionId, channel: 'web' }, 'tool_result', { preference: body.preference, ...data })
            return Response.json({ status: 'done', data }, { headers: { 'cache-control': 'no-store' } })
          }
          const tool = resolveTool(body.tool)!
          const outcome = await runBankTool(tool, body.args, {
            userId: session.userId,
            sessionId: session.sessionId,
            channel: 'web',
          })
          return Response.json(outcome, {
            headers: { 'cache-control': 'no-store' },
          })
        } catch (e) {
          return failure(e)
        }
      },
    },
  },
})

function failure(e: unknown) {
  const unauthorized = e instanceof UnauthorizedError
  return Response.json(
    {
      error: unauthorized
        ? '请先登录'
        : e instanceof z.ZodError || e instanceof SyntaxError
          ? '请检查填写的信息'
          : e instanceof Error
            ? e.message
            : '操作失败，请重试',
    },
    { status: unauthorized ? 401 : 400 },
  )
}
