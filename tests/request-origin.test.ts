import { describe, expect, it, vi } from 'vitest'
import { validRequestOrigin } from '#/server/security/request-origin'
import { Route as SecureRoute } from '#/routes/api/secure-operation'
import { Route as CardRoute } from '#/routes/api/card-number'
import { Route as OnboardingRoute } from '#/routes/api/onboarding'

vi.mock('#/server/env', async (original) => {
  const actual = await original<typeof import('#/server/env')>()
  return { env: { ...actual.env, PUBLIC_BASE_URL: 'https://wencai.35-247-141-61.sslip.io' } }
})
vi.mock('#/server/session', () => {
  class UnauthorizedError extends Error {}
  return { UnauthorizedError, requireSession: vi.fn(async () => { throw new UnauthorizedError('请先登录') }) }
})

const publicURL = 'https://wencai.35-247-141-61.sslip.io'
const request = (origin?: string, extra: Record<string, string> = {}) => new Request('http://wencai-web:3000/api/secure-operation', {
  method: 'POST', headers: { ...(origin !== undefined ? { origin } : {}), ...extra }, body: '{}',
})

describe('公网 HTTPS 来源与反向代理 HTTP 上游', () => {
  it('配置的公网来源通过校验，不要求与内部请求 URL 的协议和主机一致', () => {
    expect(validRequestOrigin(request(publicURL), publicURL)).toBe(true)
    expect(validRequestOrigin(request(publicURL + ':443'), publicURL)).toBe(true)
  })
  it.each(['http://wencai.35-247-141-61.sslip.io', 'https://evil.example', publicURL + '.evil.example',
    publicURL + ':8443', publicURL + '/path', 'null', 'not-an-origin', ''])('拒绝不受信任来源 %s', (origin) => {
    expect(validRequestOrigin(request(origin), publicURL)).toBe(false)
  })
  it('伪造 Host 和代理头不能使外部来源变为可信来源', () => {
    expect(validRequestOrigin(request('https://evil.example', {
      host: 'evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https',
      forwarded: 'host=evil.example;proto=https',
    }), publicURL)).toBe(false)
  })
  it('保留无 Origin 的同源读取和原生客户端，但拒绝明确标记的跨站请求', () => {
    expect(validRequestOrigin(request(), publicURL)).toBe(true)
    expect(validRequestOrigin(request(undefined, { 'sec-fetch-site': 'same-origin' }), publicURL)).toBe(true)
    expect(validRequestOrigin(request(undefined, { 'sec-fetch-site': 'cross-site' }), publicURL)).toBe(false)
  })
  it('本地开发仅允许同协议同端口的两个 loopback 名称', () => {
    expect(validRequestOrigin(request('http://127.0.0.1:3017'), 'http://localhost:3017')).toBe(true)
    expect(validRequestOrigin(request('http://localhost:3018'), 'http://127.0.0.1:3017')).toBe(false)
    expect(validRequestOrigin(request('https://localhost:3017'), 'http://127.0.0.1:3017')).toBe(false)
    expect(validRequestOrigin(request('http://localhost:3017'), publicURL)).toBe(false)
  })
})

type Handler = (context: { request: Request }) => Promise<Response>
const endpoints: [string, Handler][] = [
  ['安全验证', (SecureRoute.options.server!.handlers as { POST: Handler }).POST],
  ['查看卡号', (CardRoute.options.server!.handlers as { POST: Handler }).POST],
  ['初始设密', (OnboardingRoute.options.server!.handlers as { POST: Handler }).POST],
]
describe.each(endpoints)('%s 路由的代理回归', (_name, handler) => {
  it('公网来源进入会话校验，返回未登录而非错误的来源拒绝', async () => {
    const response = await handler({ request: request(publicURL) })
    expect(response.status).toBe(401)
  })
  it('真正跨站来源在进入业务前被拒绝', async () => {
    const response = await handler({ request: request('https://evil.example') })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ message: '请求来源无效' })
  })
})
