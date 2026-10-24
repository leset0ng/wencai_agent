import { createFileRoute } from '@tanstack/react-router'

/**
 * better-auth 的全部端点（/api/auth/*）：手机号验证码登录、会话查询、登出等。
 * 本项目只提供入口，其余由 better-auth 的路由接管。
 * 用 splat 路由匹配所有 /api/auth/xxx 子路径。
 */
export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      GET: ({ request }) => authHandler(request),
      POST: ({ request }) => authHandler(request),
    },
  },
})

async function authHandler(request: Request): Promise<Response> {
  const { auth } = await import('#/server/auth')
  const response = await auth.handler(request)
  const { recordAuthFailure } = await import('#/server/logging/runtime')
  await recordAuthFailure(response)
  return response
}
