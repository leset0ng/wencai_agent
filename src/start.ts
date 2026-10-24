import { createMiddleware, createStart } from '@tanstack/react-start'

const runtimeLogging = createMiddleware().server(async ({ request, next }) => {
  const { observeRuntimeRequest } = await import('#/server/logging/runtime')
  return observeRuntimeRequest(request, next)
})
export const startInstance = createStart(() => ({ requestMiddleware: [runtimeLogging] }))
