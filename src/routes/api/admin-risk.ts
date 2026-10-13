import { createHash } from 'node:crypto'
import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { env } from '#/server/env'
import { adminAuthorized } from '#/server/admin/access'
import { listAccountRiskFlags, reviewAccountRiskFlag, RiskReviewConflict } from '#/server/risk/accounts'

const reviewSchema = z.object({
  accountId: z.string().min(1).max(200), expectedRevision: z.number().int().positive(),
  decision: z.enum(['confirmed', 'cleared']),
}).strict()
const failure = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status })
function deny(request: Request) {
  if (!env.ADMIN_ENABLED) return failure(403, 'ADMIN_DISABLED', '管理后台未启用')
  if (!adminAuthorized(request)) return failure(401, 'ADMIN_AUTH_REQUIRED', '请输入后台访问凭据')
}

/** Separate human-only endpoint. Neither the user Agent nor the risk model receives this capability. */
export const Route = createFileRoute('/api/admin-risk')({ server: { handlers: {
  GET: async ({ request }) => {
    const denied = deny(request)
    if (denied) return denied
    const flags = await listAccountRiskFlags()
    return Response.json({ data: { flags, generatedAt: new Date().toISOString(), summary: {
      suspected: flags.filter((flag) => flag.status === 'suspected').length,
      confirmed: flags.filter((flag) => flag.status === 'confirmed').length,
      cleared: flags.filter((flag) => flag.status === 'cleared').length,
    } } })
  },
  POST: async ({ request }) => {
    const denied = deny(request)
    if (denied) return denied
    let body: unknown
    try { body = await request.json() } catch { return failure(400, 'INVALID_COMMAND', '复核请求格式无效') }
    const parsed = reviewSchema.safeParse(body)
    if (!parsed.success) return failure(400, 'INVALID_COMMAND', '请提供账户、当前版本和明确的复核决定')
    // Existing admin credential is a local/demo access identity, not a complete administrator role system.
    const reviewer = env.ADMIN_TOKEN ? `admin:${createHash('sha256').update(env.ADMIN_TOKEN).digest('hex').slice(0, 12)}` : 'admin:local'
    try {
      const result = await reviewAccountRiskFlag({ ...parsed.data, reviewer }, {
        userId: reviewer, sessionId: 'admin-risk-review', channel: 'web',
      })
      return Response.json({ data: result })
    } catch (error) {
      if (error instanceof RiskReviewConflict) return failure(409, 'RISK_REVIEW_CONFLICT', error.message)
      return failure(500, 'RISK_REVIEW_FAILED', '风险复核未完成，请刷新后重试')
    }
  },
} } })
