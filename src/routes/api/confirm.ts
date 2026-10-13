import { createFileRoute } from '@tanstack/react-router'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { confirmPending, getPendingForUser } from '#/server/confirm/pending'
import { db, schema } from '#/server/db/client'
import { cancelActionAndPlan } from '#/server/executor/service'
import { resolveTool } from '#/server/tools/bank'
import { requireSession } from '#/server/session'
import type { AgentContext } from '#/server/agent/context'
import { StepUpSchema } from '#/server/auth/step-up'
import { ownedSecureRequest } from '#/server/security/operation'

const BodySchema = z.object({
  actionId: z.string(),
  decision: z.enum(['confirm', 'cancel']),
  stepUp: StepUpSchema.optional(),
  secureRequestId: z.string().max(100).optional(),
})

/**
 * 用户确认入口——唯一能让黄/红操作真正执行的路径。
 * 只接受已认证用户的请求；模型没有调用它的任何途径。
 */
export const Route = createFileRoute('/api/confirm')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const actionId = new URL(request.url).searchParams.get('actionId')
        if (!actionId) return Response.json({ error: 'missing actionId' }, { status: 400 })
        let ctx
        try {
          ctx = await contextFor(request, actionId)
        } catch {
          return Response.json({ error: 'unauthorized' }, { status: 401 })
        }
        const pending = ctx && (await getPendingForUser(ctx, actionId))
        return pending ? Response.json(pending) : Response.json({ error: 'not found' }, { status: 404 })
      },
      POST: async ({ request }) => {
        const body = BodySchema.safeParse(await request.json())
        if (!body.success) return Response.json({ error: 'bad request' }, { status: 400 })
        const { actionId, decision, stepUp, secureRequestId } = body.data
        let ctx
        try {
          ctx = await contextFor(request, actionId)
        } catch {
          return Response.json({ ok: false, code: 'not_found', message: '请先登录' }, { status: 401 })
        }
        if (!ctx) return Response.json({ ok: false, code: 'not_found', message: '待确认操作不存在' }, { status: 404 })

        if (decision === 'cancel') {
          const plan = await cancelActionAndPlan(ctx, actionId)
          return Response.json({ ok: true, cancelled: true, plan })
        }

        if (secureRequestId) {
          try { await ownedSecureRequest({ ...await requireSession(request), channel: 'web' }, secureRequestId) }
          catch { return Response.json({ ok: false, code: 'card_password_required', message: '请在当前登录会话重新验证银行卡密码' }, { status: 400 }) }
        }
        const result = await confirmPending({ ctx, actionId, stepUp, secureRequestId, resolveTool })
        if (!result.ok) return Response.json(result, { status: 400 })
        return Response.json({ ...result, actionId, userId: ctx.userId })
      },
    },
  },
})

/** 会话归属于发起该操作时的会话；用户身份始终来自已认证会话 */
async function contextFor(request: Request, actionId: string): Promise<AgentContext | null> {
  const session = await requireSession(request)
  const [row] = await db.select().from(schema.pendingActions).where(eq(schema.pendingActions.id, actionId))
  if (!row || row.userId !== session.userId) return null
  return { userId: session.userId, sessionId: row.sessionId, channel: 'web' }
}
