import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { requireSession, UnauthorizedError } from '#/server/session'
import { hasTxPassword } from '#/server/auth/tx-password'
import { initializePassword } from '#/server/auth/onboarding'

export const Route = createFileRoute('/api/onboarding')({ server: { handlers: {
  GET: async ({ request }) => {
    try {
      const session = await requireSession(request)
      return Response.json({ ready: await hasTxPassword(session.userId) }, { headers: { 'cache-control': 'private, no-store' } })
    } catch { return Response.json({ message: '请先登录' }, { status: 401 }) }
  },
  POST: async ({ request }) => {
    const origin = request.headers.get('origin')
    if (origin && origin !== new URL(request.url).origin) return Response.json({ message: '请求来源无效' }, { status: 403 })
    try {
      const session = await requireSession(request)
      const { password } = z.object({ password: z.string().regex(/^\d{6}$/) }).parse(await request.json())
      await initializePassword(session, password)
      return Response.json({ ready: true }, { headers: { 'cache-control': 'private, no-store' } })
    } catch (error) { return Response.json({ message: error instanceof Error ? error.message : '设置失败' }, { status: error instanceof UnauthorizedError ? 401 : 400 }) }
  },
} } })
