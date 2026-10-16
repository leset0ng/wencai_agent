import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { requireSession, UnauthorizedError } from '#/server/session'
import { listPaymentPayees, paymentAccounts } from '#/server/payments/service'
import { resolveTool } from '#/server/tools/bank'
import { runBankTool } from '#/server/tools/runner'

const bodySchema = z.object({
  tool: z.enum(['search_bank_accounts', 'add_payee', 'transfer', 'transfer_between_accounts', 'transfer_between_cards', 'repay_credit_card', 'set_card_remark', 'lock_card', 'unlock_card', 'report_card_lost', 'adjust_card_limit', 'apply_card', 'adjust_credit_limit', 'cancel_subscription']),
  args: z.record(z.string(), z.unknown()),
})

export const Route = createFileRoute('/api/payments')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const session = await requireSession(request)
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
          const body = bodySchema.parse(await request.json())
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
