import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Route } from '#/routes/api/admin-risk'
import { RiskReviewConflict } from '#/server/risk/accounts'

const mocks = vi.hoisted(() => ({
  env: { ADMIN_ENABLED: true, ADMIN_TOKEN: undefined as string | undefined },
  authorized: vi.fn(),
  list: vi.fn(),
  review: vi.fn(),
}))
vi.mock('#/server/env', () => ({ env: mocks.env }))
vi.mock('#/server/admin/access', () => ({ adminAuthorized: mocks.authorized }))
vi.mock('#/server/risk/accounts', () => ({
  listAccountRiskFlags: mocks.list,
  reviewAccountRiskFlag: mocks.review,
  RiskReviewConflict: class RiskReviewConflict extends Error {
    constructor() { super('风险标记已更新，请刷新后重新复核') }
  },
}))

const handlers = Route.options.server!.handlers as {
  GET: (context: { request: Request }) => Promise<Response>
  POST: (context: { request: Request }) => Promise<Response>
}
const valid = { accountId: 'risk-account', expectedRevision: 3, decision: 'confirmed' as const }
const flag = {
  accountId: valid.accountId, status: 'suspected', revision: 3, userId: 'risk-owner', ownerName: '待复核用户', accountName: '收款账户',
  features: { ownerAgeDays: null, incomingCount24h: 5, incomingCents24h: 10000, distinctPayers24h: 4, outgoingCents24h: 8000, rapidOutflowRatio: 0.8 },
  reasons: ['短期内来自多名不同付款人的集中入账'], source: 'ai',
  createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T01:00:00.000Z', reviewedBy: null, reviewedAt: null,
}
const get = () => handlers.GET({ request: new Request('http://localhost/api/admin-risk') })
const post = (body: unknown, headers?: Record<string, string>) => handlers.POST({
  request: new Request('http://localhost/api/admin-risk', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  }),
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.env.ADMIN_ENABLED = true
  mocks.env.ADMIN_TOKEN = undefined
  mocks.authorized.mockReturnValue(true)
  mocks.list.mockResolvedValue([flag])
  mocks.review.mockResolvedValue({ accountId: valid.accountId, status: 'confirmed', revision: 4 })
})

describe('收款风险人工复核管理接口', () => {
  it.each(['GET', 'POST'] as const)('后台关闭时 %s 不读取或写入风险数据', async (method) => {
    mocks.env.ADMIN_ENABLED = false
    const response = method === 'GET' ? await get() : await post(valid)
    expect(response.status).toBe(403)
    expect(mocks.list).not.toHaveBeenCalled()
    expect(mocks.review).not.toHaveBeenCalled()
  })

  it.each(['GET', 'POST'] as const)('未通过后台验证的 %s 不触及风险数据', async (method) => {
    mocks.authorized.mockReturnValue(false)
    const response = method === 'GET' ? await get() : await post(valid)
    expect(response.status).toBe(401)
    expect(mocks.authorized).toHaveBeenCalledOnce()
    expect(mocks.list).not.toHaveBeenCalled()
    expect(mocks.review).not.toHaveBeenCalled()
  })

  it('未授权 POST 在解析不合法 JSON 之前即被拒绝', async () => {
    mocks.authorized.mockReturnValue(false)
    const response = await handlers.POST({ request: new Request('http://localhost/api/admin-risk', { method: 'POST', body: '{broken' }) })
    expect(response.status).toBe(401)
    expect(mocks.list).not.toHaveBeenCalled()
    expect(mocks.review).not.toHaveBeenCalled()
  })

  it('授权 GET 返回全局记录及各状态计数', async () => {
    const flags = [flag, { ...flag, accountId: 'risk-confirmed', status: 'confirmed' }, { ...flag, accountId: 'risk-cleared', status: 'cleared' }]
    mocks.list.mockResolvedValue(flags)
    const response = await get()
    expect(response.status).toBe(200)
    const { data } = await response.json()
    expect(data.flags).toEqual(flags)
    expect(data.summary).toEqual({ suspected: 1, confirmed: 1, cleared: 1 })
    expect(Number.isNaN(Date.parse(data.generatedAt))).toBe(false)
    expect(mocks.list).toHaveBeenCalledOnce()
    expect(mocks.review).not.toHaveBeenCalled()
  })

  it.each([
    { ...valid, reviewer: 'attacker' },
    { ...valid, status: 'cleared' },
    { ...valid, userId: 'different-owner' },
    { ...valid, decision: 'suspected' },
    { ...valid, decision: 'allow' },
    { ...valid, expectedRevision: 0 },
    { ...valid, expectedRevision: 1.5 },
    { ...valid, expectedRevision: '3' },
    { ...valid, accountId: '' },
    { ...valid, accountId: 'x'.repeat(201) },
    { ...valid, accountId: 123 },
    null,
    [],
  ])('拒绝无效参数或调用方注入的身份/状态：%j', async (body) => {
    const response = await post(body)
    expect(response.status).toBe(400)
    expect(mocks.review).not.toHaveBeenCalled()
  })

  it('合法授权但 JSON 损坏时返回 400 且不执行复核', async () => {
    const response = await handlers.POST({ request: new Request('http://localhost/api/admin-risk', { method: 'POST', body: '{broken' }) })
    expect(response.status).toBe(400)
    expect(mocks.review).not.toHaveBeenCalled()
  })

  it.each(['confirmed', 'cleared'] as const)('仅以调用方明确选择的 %s 决定和预期版本执行复核', async (decision) => {
    const response = await post({ ...valid, decision })
    expect(response.status).toBe(200)
    expect(mocks.review).toHaveBeenCalledOnce()
    const [input, context] = mocks.review.mock.calls[0]
    expect(input).toEqual({ ...valid, decision, reviewer: expect.any(String) })
    expect(input.reviewer.trim()).not.toBe('')
    expect(input.reviewer).toBe('admin:local')
    expect(context).toEqual({ userId: input.reviewer, sessionId: 'admin-risk-review', channel: 'web' })
  })

  it('复核人根据服务端管理凭据生成，不使用自报身份，也不记录明文凭据', async () => {
    mocks.env.ADMIN_TOKEN = 'test-server-admin-credential-at-least-24'
    await post(valid, { 'x-admin-user': 'attacker', authorization: 'Bearer untrusted-header-value' })
    const [firstInput] = mocks.review.mock.calls[0]
    expect(firstInput.reviewer).toBe(`admin:${createHash('sha256').update(mocks.env.ADMIN_TOKEN).digest('hex').slice(0, 12)}`)
    expect(firstInput.reviewer).not.toContain('attacker')
    expect(firstInput.reviewer).not.toContain('untrusted-header-value')
    expect(firstInput.reviewer).not.toContain(mocks.env.ADMIN_TOKEN)
    expect(firstInput.reviewer).not.toBe('')
    expect(mocks.review.mock.calls[0][1].userId).toBe(firstInput.reviewer)
    await post(valid, { 'x-admin-user': 'another-identity' })
    expect(mocks.review.mock.calls[1][0].reviewer).toBe(firstInput.reviewer)
    mocks.env.ADMIN_TOKEN = 'another-server-admin-credential-at-least-24'
    await post(valid)
    expect(mocks.review.mock.calls[2][0].reviewer).not.toBe(firstInput.reviewer)
  })

  it('并发版本冲突返回 409，客户端必须重新核对', async () => {
    mocks.review.mockRejectedValueOnce(new RiskReviewConflict())
    const response = await post(valid)
    expect(response.status).toBe(409)
    const body = await response.json()
    expect(body.error.message).toContain('刷新')
    expect(mocks.review).toHaveBeenCalledOnce()
  })
})
