import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { requireSession, UnauthorizedError } from '#/server/session'
import { createSecureRequest, secureRequestInfo, submitSecureRequest, consumeSecureResult, cancelSecureRequest } from '#/server/security/operation'
import { StepUpSchema } from '#/server/auth/step-up'
import { validRequestOrigin } from '#/server/security/request-origin'
const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), purpose: z.enum(['confirm_action', 'view_card', 'change_card_password']), cardId: z.string().max(200).optional(), actionId: z.string().max(200).optional() }),
  z.object({ action: z.literal('submit'), id: z.string().max(100), password: z.string().regex(/^\d{6}$/).optional(), method: z.enum(['password', 'sms', 'fingerprint', 'face']).optional(), stepUp: StepUpSchema.optional() }),
  z.object({ action: z.enum(['result', 'cancel']), id: z.string().max(100) }),
])
export const Route = createFileRoute('/api/secure-operation')({ server: { handlers: {
  GET: async ({ request }) => handle(request), POST: async ({ request }) => handle(request),
} } })
async function handle(request: Request) {
  const headers = { 'cache-control': 'private, no-store', pragma: 'no-cache' }
  if (!validRequestOrigin(request)) return Response.json({ message: '请求来源无效' }, { status: 403, headers })
  try {
    const session = await requireSession(request), ctx = { ...session, channel: 'web' as const }
    if (request.method === 'GET') return Response.json(await secureRequestInfo(ctx, new URL(request.url).searchParams.get('id') ?? ''), { headers })
    const body = bodySchema.parse(await request.json())
    const result = body.action === 'create' ? await createSecureRequest(ctx, body) : body.action === 'submit' ? await submitSecureRequest(ctx, body.id, body) : body.action === 'result' ? await consumeSecureResult(ctx, body.id) : await cancelSecureRequest(ctx, body.id)
    return Response.json(result, { status: 'ok' in result && result.ok === false ? 400 : 200, headers })
  } catch (error) { return Response.json({ message: error instanceof z.ZodError ? '请检查输入信息' : error instanceof Error ? error.message : '安全操作失败' }, { status: error instanceof UnauthorizedError ? 401 : 400, headers }) }
}
