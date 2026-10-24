import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  observeRuntimeRequest,
  recordAuthFailure,
  redactRuntimeMessage,
  runtimeLog,
  runtimeLogSnapshot,
} from '#/server/logging/runtime'
const { config } = vi.hoisted(() => ({
  config: {
    ADMIN_ENABLED: true,
    AUTH_DEMO_MODE: true,
    ADMIN_TOKEN: 'a-valid-admin-credential-for-tests',
    PUBLIC_BASE_URL: 'https://bank.test',
  },
}))
vi.mock('#/server/env', () => ({ env: config }))
import { getRuntimeLogs } from '#/server/admin/runtime-logs'
afterEach(() => {
  config.ADMIN_ENABLED = true
  config.AUTH_DEMO_MODE = true
  vi.unstubAllEnvs()
})
const request = (path = '/api/admin?action=logs', headers?: HeadersInit) =>
  new Request(`https://bank.test${path}`, { headers })

describe('后台实时日志', () => {
  it('只展示固定认证校验提示，不采集未知错误正文', async () => {
    const before = runtimeLogSnapshot().entries.at(-1)?.id ?? 0
    await recordAuthFailure(Response.json({ message: '请输入有效的手机号' }, { status: 400 }))
    await recordAuthFailure(Response.json({ message: '用户填写的私密文字' }, { status: 400 }))
    const fresh = runtimeLogSnapshot().entries.filter((entry) => entry.id > before)
    expect(fresh.map((entry) => entry.message)).toEqual(['认证失败 · 请输入有效的手机号'])
  })
  it('演示模式可以查看，后台关闭或非演示模式未验证时不可读取', async () => {
    runtimeLog('info', 'system', 'access-test-event')
    const allowed = getRuntimeLogs(request())
    expect(allowed.status).toBe(200)
    expect(allowed.headers.get('cache-control')).toContain('no-store')
    expect(
      (await allowed.json()).data.entries.some((entry: { message: string }) => entry.message === 'access-test-event'),
    ).toBe(true)
    config.AUTH_DEMO_MODE = false
    expect(getRuntimeLogs(request()).status).toBe(401)
    expect(getRuntimeLogs(request(undefined, { authorization: `Bearer ${config.ADMIN_TOKEN}` })).status).toBe(200)
    config.ADMIN_ENABLED = false
    expect(getRuntimeLogs(request()).status).toBe(403)
  })
  it('记录前隐藏凭据、号码、远程地址和控制字符，限制单条长度', () => {
    vi.stubEnv('TEST_API_KEY', 'private-provider-key')
    const clean = redactRuntimeMessage(
      'password=abc123 token=private-value Bearer secret-bearer phone +86 13800000000 OTP 123456 card 6222000012345678 https://server.test/?code=hidden user@bank.test private-provider-key\nforged',
    )
    for (const secret of [
      'abc123',
      'private-value',
      'secret-bearer',
      '13800000000',
      '123456',
      '6222000012345678',
      'code=hidden',
      'user@bank.test',
      'private-provider-key',
      '\n',
    ])
      expect(clean).not.toContain(secret)
    expect(redactRuntimeMessage('a'.repeat(3000)).length).toBeLessThanOrEqual(1200)
  })
  it('内存有上限，快照不能修改服务端记录', () => {
    for (let i = 0; i < 510; i++) runtimeLog('info', 'system', `bounded-entry-${i}`)
    const snapshot = runtimeLogSnapshot()
    expect(snapshot.entries.length).toBe(snapshot.capacity)
    expect(snapshot.entries[0].message).toBe('bounded-entry-10')
    snapshot.entries[0].message = 'changed'
    snapshot.entries.pop()
    expect(runtimeLogSnapshot().entries[0].message).toBe('bounded-entry-10')
    expect(runtimeLogSnapshot().entries.length).toBe(500)
  })
  it('认证请求记录状态、耗时和关联编号，不记录正文、查询串、Cookie', async () => {
    const before = runtimeLogSnapshot().entries.at(-1)!.id
    const req = new Request('https://bank.test/api/auth/phone-number/verify?token=query-private', {
      method: 'POST',
      headers: { cookie: 'session=cookie-private' },
      body: JSON.stringify({ code: '654321', phoneNumber: '13800000000' }),
    })
    const response = Response.json({ code: 'INVALID_OTP', message: 'never-log-this-message' }, { status: 400 })
    const result = await observeRuntimeRequest(req, async () => {
      await recordAuthFailure(response)
      return { response }
    })
    expect(await result.response.json()).toHaveProperty('code', 'INVALID_OTP')
    const entries = runtimeLogSnapshot().entries.filter((entry) => entry.id > before)
    expect(entries).toHaveLength(2)
    expect(entries[0].message).toBe('认证失败 · INVALID_OTP')
    expect(entries[1].message).toMatch(/POST \/api\/auth\/phone-number\/verify → 400/)
    expect(entries[1].level).toBe('warn')
    expect(entries[0].requestId).toBe(entries[1].requestId)
    expect(entries[0].requestId).toBeTruthy()
    for (const secret of ['654321', '13800000000', 'query-private', 'cookie-private', 'never-log-this-message'])
      expect(JSON.stringify(entries)).not.toContain(secret)
  })
  it('请求异常仍上抛，同时记录错误；轮询日志不会生成日志', async () => {
    const error = new Error('database unavailable')
    await expect(
      observeRuntimeRequest(request('/api/dashboard'), async () => {
        throw error
      }),
    ).rejects.toBe(error)
    expect(runtimeLogSnapshot().entries.at(-1)).toMatchObject({
      level: 'error',
      message: expect.stringContaining('database unavailable'),
    })
    const before = runtimeLogSnapshot().entries.at(-1)!.id
    await observeRuntimeRequest(request(), async () => ({ response: getRuntimeLogs(request()) }))
    expect(runtimeLogSnapshot().entries.at(-1)!.id).toBe(before)
  })
})
