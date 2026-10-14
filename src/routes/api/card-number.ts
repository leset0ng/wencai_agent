import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { requireSession, UnauthorizedError } from '#/server/session'
import { revealCardNumber } from '#/server/cards/numbers'
import { validRequestOrigin } from '#/server/security/request-origin'
export const Route = createFileRoute('/api/card-number')({ server: { handlers: {
  POST: async ({ request }) => {
    // Explicit same-origin check: passwords never accepted through cross-site forms.
    if (!validRequestOrigin(request)) return Response.json({ message: '请求来源无效' }, { status: 403 })
    try {
      const session = await requireSession(request)
      const { cardId, password } = z.object({ cardId: z.string().min(1).max(200), password: z.string().regex(/^\d{6}$/) }).parse(await request.json())
      const result = await revealCardNumber({ ...session, channel: 'web' }, cardId, password)
      return Response.json(result, { headers: { 'cache-control': 'private, no-store', pragma: 'no-cache' } })
    } catch (error) { return Response.json({ message: error instanceof Error ? error.message : '验证失败' }, { status: error instanceof UnauthorizedError ? 401 : 400, headers: { 'cache-control': 'no-store' } }) }
  },
} } })
