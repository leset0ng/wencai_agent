import { env } from '#/server/env'
import { adminAuthorized } from './access'
import { runtimeLogSnapshot } from '#/server/logging/runtime'

export function getRuntimeLogs(request: Request) {
  const headers = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' }
  if (!env.ADMIN_ENABLED)
    return Response.json({ error: { code: 'ADMIN_DISABLED', message: '管理后台未启用' } }, { status: 403, headers })
  if (!adminAuthorized(request))
    return Response.json(
      { error: { code: 'ADMIN_AUTH_REQUIRED', message: '请输入后台访问凭据' } },
      { status: 401, headers },
    )
  return Response.json({ data: runtimeLogSnapshot() }, { headers })
}
