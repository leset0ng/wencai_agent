import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { listMandates, revokeMandate } from '#/server/automation/mandates'
import { requireSession } from '#/server/session'

/**
 * 常设授权的查询与撤销。
 * 这里**没有创建与执行入口**：创建只能走 Agent 的红色确认单，执行只由后台到期触发。
 * 撤销只要求已登录——停止是安全方向的操作，不设强验证。
 */
export const Route = createFileRoute('/api/mandates')({ server: { handlers: {
  GET: async ({ request }) => {
    const session = await requireSession(request).catch(() => null)
    if (!session) return Response.json({ message: '请先登录' }, { status: 401 })
    return Response.json({ mandates: await listMandates(session.userId) })
  },
  POST: async ({ request }) => {
    const session = await requireSession(request).catch(() => null)
    if (!session) return Response.json({ message: '请先登录' }, { status: 401 })
    const body = z.object({ mandateId: z.string().min(1).max(100), command: z.literal('revoke') }).safeParse(await request.json().catch(() => null))
    if (!body.success) return Response.json({ message: '请求无效' }, { status: 400 })
    try {
      const mandate = await revokeMandate({ userId: session.userId, sessionId: session.sessionId, channel: 'web' }, body.data.mandateId)
      return Response.json({ ok: true, mandate })
    } catch (error) {
      return Response.json({ ok: false, message: error instanceof Error ? error.message : '撤销失败' }, { status: 400 })
    }
  },
} } })
