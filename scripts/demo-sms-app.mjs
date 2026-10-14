import { timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'

/** Private demo adapter: no published port, explicit opt-in and a separate shared secret. */
export function createDemoSmsApp({ enabled, token, log = console.info }) {
  const app = new Hono()
  app.use('*', bodyLimit({ maxSize: 2048 }))
  app.post('/send', async (c) => {
    if (!enabled || !token || token.length < 32) return c.json({ error: 'disabled' }, 503)
    const provided = Buffer.from(c.req.header('authorization')?.replace(/^Bearer /, '') ?? '')
    const expected = Buffer.from(token)
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return c.json({ error: 'unauthorized' }, 401)
    const data = await c.req.json().catch(() => null)
    if (!data || typeof data.phoneNumber !== 'string' || !/^\+?\d{8,16}$/.test(data.phoneNumber) ||
        typeof data.code !== 'string' || !/^\d{6}$/.test(data.code) || data.purpose !== 'wencai-verification') {
      return c.json({ error: 'invalid_payload' }, 400)
    }
    const phone = data.phoneNumber
    log(`[demo-sms] 演示验证码（未发送真实短信） ${phone.slice(0, 3)}****${phone.slice(-4)}: ${data.code}`)
    return c.json({ ok: true, demo: true })
  })
  return app
}
