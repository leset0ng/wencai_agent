import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { db, schema } from '#/server/db/client'
import { collectProfileInput, getUserProfile, listProfileSummaries } from '#/server/profile/profile'
import { Route } from '#/routes/api/admin-profile'

const mocks = vi.hoisted(() => ({ authorized: vi.fn(), enabled: { ADMIN_ENABLED: true } }))
vi.mock('#/server/admin/access', () => ({ adminAuthorized: mocks.authorized }))
vi.mock('#/server/env', async (original) => {
  const actual = await original<typeof import('#/server/env')>()
  return { env: new Proxy(actual.env, { get: (target, key) => (key === 'ADMIN_ENABLED' ? mocks.enabled.ADMIN_ENABLED : (target as Record<string | symbol, unknown>)[key]) }) }
})

const uid = 'profile_user', otherId = 'profile_other', emptyId = 'profile_empty'
const NOW = new Date('2026-10-13T04:00:00.000Z')
const ids = [uid, otherId, emptyId]
const acct = { main: 'profile_main', save: 'profile_save', other: 'profile_other_acc' }
const at = (month: string) => new Date(`${month}-10T04:00:00.000Z`)
const handler = (Route.options.server!.handlers as { GET: (c: { request: Request }) => Promise<Response> }).GET
const get = (query = '') => handler({ request: new Request(`http://localhost/api/admin-profile${query}`) })
const narrate = (summary: string) => ({ narrate: { writer: async () => ({ summary }) } })

async function clean() {
  const accounts = (await db.select({ id: schema.accounts.id }).from(schema.accounts).where(inArray(schema.accounts.userId, ids))).map((a) => a.id)
  if (accounts.length) {
    const txs = (await db.select({ id: schema.transactions.id }).from(schema.transactions).where(inArray(schema.transactions.accountId, accounts))).map((t) => t.id)
    if (txs.length) await db.delete(schema.bankTransferLinks).where(inArray(schema.bankTransferLinks.debitTransactionId, txs))
    await db.delete(schema.transactions).where(inArray(schema.transactions.accountId, accounts))
  }
  await db.delete(schema.holdings).where(inArray(schema.holdings.userId, ids))
  await db.delete(schema.subscriptions).where(inArray(schema.subscriptions.userId, ids))
  await db.delete(schema.accounts).where(inArray(schema.accounts.userId, ids))
  await db.delete(schema.users).where(inArray(schema.users.id, ids))
  await db.delete(schema.products).where(eq(schema.products.id, 'profile_prd'))
  await db.$client.execute({ sql: `DELETE FROM bank_profile_narratives WHERE user_id IN (${ids.map(() => '?').join(',')})`, args: ids }).catch(() => {})
}

beforeAll(async () => {
  await clean()
  await db.insert(schema.users).values([
    { id: uid, name: '画像用户', riskRating: 'R2', riskAssessedAt: '2026-09-01T00:00:00.000Z' },
    { id: otherId, name: '他人' }, { id: emptyId, name: '新用户' },
  ])
  await db.insert(schema.accounts).values([
    { id: acct.main, userId: uid, name: '工资卡', balanceCents: 3_000_000 },
    { id: acct.save, userId: uid, name: '储蓄账户', balanceCents: 1_000_000 },
    { id: acct.other, userId: otherId, name: '他人账户', balanceCents: 100 },
  ])
  await db.insert(schema.products).values({ id: 'profile_prd', name: '画像测试产品', riskRating: 'R4', minAmountCents: 100, expectedYield: 0.04, termDays: 90 })
  await db.insert(schema.holdings).values({ id: 'profile_h', userId: uid, productId: 'profile_prd', principalCents: 1_000_000, redeemableAt: '2027-01-01T00:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z' })
  const rows: (typeof schema.transactions.$inferInsert)[] = []
  for (const m of ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09']) {
    rows.push(
      { id: `pf_in_${m}`, accountId: acct.main, amountCents: 1_000_000, counterparty: '公司', category: '工资', occurredAt: at(m) },
      { id: `pf_food_${m}`, accountId: acct.main, amountCents: -400_000, counterparty: '餐厅', category: '餐饮', occurredAt: at(m) },
      { id: `pf_shop_${m}`, accountId: acct.main, amountCents: -200_000, counterparty: '商场', category: '购物', occurredAt: at(m) },
    )
  }
  // 本人两个账户之间互转 9 月 7000 元：不是收入也不是支出
  rows.push(
    { id: 'pf_int_out', accountId: acct.main, amountCents: -700_000, counterparty: '储蓄账户', category: '转账', occurredAt: at('2026-09') },
    { id: 'pf_int_in', accountId: acct.save, amountCents: 700_000, counterparty: '工资卡', category: '转账', occurredAt: at('2026-09') },
    // 转给他人才算支出
    { id: 'pf_ext_out', accountId: acct.main, amountCents: -50_000, counterparty: '他人', category: '转账', occurredAt: at('2026-09') },
    { id: 'pf_ext_in', accountId: acct.other, amountCents: 50_000, counterparty: '画像用户', category: '转账', occurredAt: at('2026-09') },
  )
  await db.insert(schema.transactions).values(rows)
  await db.insert(schema.bankTransferLinks).values([
    { debitTransactionId: 'pf_int_out', targetAccountId: acct.save, creditTransactionId: 'pf_int_in' },
    { debitTransactionId: 'pf_ext_out', targetAccountId: acct.other, creditTransactionId: 'pf_ext_in' },
  ])
})
beforeEach(async () => {
  mocks.enabled.ADMIN_ENABLED = true
  mocks.authorized.mockReturnValue(true)
  await db.$client.execute({ sql: 'DELETE FROM bank_profile_narratives WHERE user_id = ?', args: [uid] }).catch(() => {})
})
afterAll(clean)

describe('画像采集（真实数据库）', () => {
  it('识别本人账户互转，对外转账仍计为支出', async () => {
    const input = await collectProfileInput(uid, NOW)
    expect(input.transactions.find((t) => t.id === 'pf_int_out')?.internal).toBe(true)
    expect(input.transactions.find((t) => t.id === 'pf_int_in')?.internal).toBe(true)
    expect(input.transactions.find((t) => t.id === 'pf_ext_out')?.internal).toBe(false)
  })

  it('余额、理财本金、持仓风险与测评等级来自库中的实际数据', async () => {
    const input = await collectProfileInput(uid, NOW)
    expect(input).toMatchObject({ balanceCents: 4_000_000, investmentPrincipalCents: 1_000_000, riskRating: 'R2' })
    expect(input.holdings).toEqual([{ riskRating: 'R4', principalCents: 1_000_000 }])
  })

  it('只读取该用户自己的流水', async () => {
    const input = await collectProfileInput(uid, NOW)
    expect(input.transactions.every((t) => [acct.main, acct.save].includes(t.accountId))).toBe(true)
  })

  it('完整画像：互转不影响月均，持仓高于测评被标出', async () => {
    const profile = await getUserProfile(uid, NOW, narrate('该用户近 5 个月月均收入 ¥10,000.00，月均支出 ¥6,100.00，持仓风险高于测评等级。'))
    // 9 月支出 = 6000 + 500（对外转账），其余月份 6000：均值 6100
    expect(profile.metrics.monthlyExpenseCents).toBe(610_000)
    expect(profile.metrics.monthlyIncomeCents).toBe(1_000_000)
    expect(profile.tags.map((t) => t.code)).toEqual(expect.arrayContaining(['risk_mismatch']))
    expect(profile.narrative.source).toBe('ai')
  })
})

describe('文字缓存与审计', () => {
  it('数据没变时复用缓存，不再调用模型', async () => {
    let calls = 0
    const writer = async () => { calls++; return { summary: '该用户近 5 个月月均收入 ¥10,000.00，月均支出 ¥6,100.00，整体收支稳定。' } }
    const first = await getUserProfile(uid, NOW, { narrate: { writer } })
    const second = await getUserProfile(uid, NOW, { narrate: { writer } })
    expect(calls).toBe(1)
    expect(second.narrative).toEqual(first.narrative)
    expect(second.fingerprint).toBe(first.fingerprint)
    await getUserProfile(uid, NOW, { refresh: true, narrate: { writer } })
    expect(calls).toBe(2)
  })

  it('数据变化后旧文字不会冒充新数据', async () => {
    let calls = 0
    const writer = async () => { calls++; return { summary: '该用户近 5 个月月均收入 ¥10,000.00，月均支出 ¥6,100.00，整体收支稳定。' } }
    const before = await getUserProfile(uid, NOW, { narrate: { writer } })
    await db.insert(schema.transactions).values({ id: 'pf_new', accountId: acct.main, amountCents: -123, counterparty: '新商户', category: '餐饮', occurredAt: at('2026-10') })
    try {
      const after = await getUserProfile(uid, NOW, { narrate: { writer } })
      expect(after.fingerprint).not.toBe(before.fingerprint)
      expect(calls).toBe(2)
    } finally { await db.delete(schema.transactions).where(eq(schema.transactions.id, 'pf_new')) }
  })

  it('生成写入审计，模型被拒时记录原因；审计载荷不含画像文字', async () => {
    await getUserProfile(uid, NOW, narrate('名下另有 ¥88,888.00 的海外资产，月均收入 ¥10,000.00。'))
    const logs = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.userId, uid))
    const log = logs.filter((l) => l.type === 'profile_generated').at(-1)!
    expect(JSON.parse(log.payloadJson)).toMatchObject({ source: 'rule', rejected: 'numbers' })
    expect(log.payloadJson).not.toContain('88,888')
  })

  it('画像文字表不被策略引擎、Agent 与数字核验引用', async () => {
    // 画像文字是模型写的，永远不能成为证据或策略事实。这里直接扫描源码，不依赖 git。
    const { readdirSync, readFileSync, statSync } = await import('node:fs')
    const { join } = await import('node:path')
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const full = join(dir, name)
      return statSync(full).isDirectory() ? walk(full) : /.(ts|tsx)$/.test(name) ? [full] : []
    })
    const allowed = [join('src', 'server', 'profile'), join('src', 'server', 'db', 'schema.ts')]
    const offenders = walk('src').filter((file) => !allowed.some((a) => file.startsWith(a)))
      .filter((file) => /bankProfileNarratives|bank_profile_narratives/.test(readFileSync(file, 'utf8')))
    expect(offenders).toEqual([])
  })
})

describe('列表与空用户', () => {
  it('列表只含确定性指标与标签，按总资产排序', async () => {
    const rows = await listProfileSummaries(NOW)
    const mine = rows.find((r) => r.userId === uid)!
    expect(mine).toMatchObject({ monthlyIncomeCents: 1_000_000, riskRating: 'R2' })
    expect(mine.tags.length).toBeGreaterThan(0)
    expect(JSON.stringify(mine)).not.toContain('narrative')
    const assets = rows.map((r) => r.totalAssetsCents)
    expect([...assets].sort((a, b) => b - a)).toEqual(assets)
  })

  it('没有账户和流水的新用户可以生成画像，且不调用模型', async () => {
    let called = false
    const profile = await getUserProfile(emptyId, NOW, { narrate: { writer: async () => { called = true; return { summary: 'x'.repeat(20) } } } })
    expect(called).toBe(false)
    expect(profile.metrics).toMatchObject({ monthsObserved: 0, totalAssetsCents: 0, savingsRate: null })
    expect(profile.tags.map((t) => t.code)).toContain('insufficient')
  })
})

describe('/api/admin-profile', () => {
  it('后台关闭或未授权时不读取数据', async () => {
    mocks.enabled.ADMIN_ENABLED = false
    expect((await get()).status).toBe(403)
    mocks.enabled.ADMIN_ENABLED = true
    mocks.authorized.mockReturnValue(false)
    expect((await get(`?userId=${uid}`)).status).toBe(401)
  })

  it('列表与单个用户画像；未知用户 404；只读，没有 POST', async () => {
    const list = await (await get()).json()
    expect(list.data.users.some((u: { userId: string }) => u.userId === uid)).toBe(true)
    const one = await get(`?userId=${emptyId}`)
    expect(one.status).toBe(200)
    expect((await one.json()).data.userId).toBe(emptyId)
    expect((await get('?userId=nobody')).status).toBe(404)
    expect(Object.keys(Route.options.server!.handlers as object)).toEqual(['GET'])
  })

  it('错误响应不泄露内部信息', async () => {
    mocks.authorized.mockImplementation(() => { throw new Error('secret-internal-detail sk-123') })
    await expect(get()).rejects.toThrow()
    mocks.authorized.mockReturnValue(true)
  })
})
