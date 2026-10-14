import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'

process.chdir(fileURLToPath(new URL('../', import.meta.url)))
const { default: handler } = await import('../dist/server/server.js')
const app = new Hono()
app.use('*', async (c, next) => {
  const started = performance.now()
  await next()
  // Never log query strings, headers, cookies, or request bodies.
  if (c.req.path !== '/api/health' && !c.req.path.startsWith('/assets/')) {
    console.info(`[web] ${c.req.method} ${c.req.path} ${c.res.status} ${Math.round(performance.now() - started)}ms`)
  }
})
app.get('/api/health', (c) => c.json({ status: 'ok', revision: process.env.APP_REVISION ?? 'unknown' }))
app.use('*', serveStatic({ root: './dist/client', onFound: (_path, c) => {
  if (c.req.path.startsWith('/assets/')) c.header('Cache-Control', 'public, max-age=31536000, immutable')
} }))
app.all('*', (c) => handler.fetch(c.req.raw))
const server = serve({ fetch: app.fetch, hostname: process.env.HOST ?? '0.0.0.0', port: Number(process.env.PORT ?? 3000) }, (info) => {
  console.info(`[web] 文财已启动，端口 ${info.port}，演示模式 ${process.env.AUTH_DEMO_MODE === 'true' ? '开启' : '关闭'}`)
})
let stopping = false
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  if (stopping) return
  stopping = true
  server.close(() => process.exit(0))
  server.closeIdleConnections()
  setTimeout(() => process.exit(1), 15_000).unref()
})
