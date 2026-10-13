import { createFileRoute } from '@tanstack/react-router'
import { env } from '#/server/env'
import { adminAuthorized } from '#/server/admin/access'
import { adminUserExists } from '#/server/admin/users'
import { getUserProfile, listProfileSummaries } from '#/server/profile/profile'
import { simNow } from '#/server/tools/jobs'

const failure = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status })

/**
 * 后台用户画像。只读：没有写入业务数据的入口，也没有任何 POST。
 * 画像不进入策略引擎与 Agent；用户端对话和用户 Cookie 都读不到这个接口。
 */
export const Route = createFileRoute('/api/admin-profile')({ server: { handlers: {
  GET: async ({ request }) => {
    if (!env.ADMIN_ENABLED) return failure(403, 'ADMIN_DISABLED', '管理后台未启用')
    if (!adminAuthorized(request)) return failure(401, 'ADMIN_AUTH_REQUIRED', '请输入后台访问凭据')
    const url = new URL(request.url)
    const userId = url.searchParams.get('userId')
    try {
      const now = await simNow()
      if (!userId) return Response.json({ data: { users: await listProfileSummaries(now), generatedAt: new Date().toISOString() } })
      if (!(await adminUserExists(userId))) return failure(404, 'USER_NOT_FOUND', '用户不存在')
      return Response.json({ data: await getUserProfile(userId, now, { refresh: url.searchParams.get('refresh') === '1' }) })
    } catch {
      return failure(500, 'PROFILE_FAILED', '画像暂时无法生成，请稍后重试')
    }
  },
} } })
