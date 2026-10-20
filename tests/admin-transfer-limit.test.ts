import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { db, schema } from '#/server/db/client'
import { Route } from '#/routes/api/admin'
import { settleTransfer } from '#/server/payments/service'
import { authorizeAdminTransfer, type AdminTransferGrant } from '#/server/admin/access'
import { env } from '#/server/env'
import type { AgentContext } from '#/server/agent/context'

const uid = 'u_admin_limit', accountId = 'acc_admin_limit', payeeId = 'p_admin_limit'
const NOW = new Date('2026-10-20T04:00:00.000Z')
const handlers = Route.options.server!.handlers as { POST: (c: { request: Request }) => Promise<Response> }
const ctx = (extra: Partial<AgentContext> = {}): AgentContext => ({ userId: uid, sessionId: 'limit-test', channel: 'web', ...extra })
const input = (amountCents: number) => ({ fromAccountId: accountId, payeeId, amountCents })
const adminTransfer = (amountCents: number) => handlers.POST({ request: new Request('http://localhost/api/admin', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-user': uid },
  body: JSON.stringify({ type: 'transfer', recipient: payeeId, amount: amountCents, memo: '后台转账' }),
}) })
const balance = async () => (await db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId)))[0].balanceCents
let originalClock: string | undefined

async function clear() {
  const txs = (await db.select({ id: schema.transactions.id }).from(schema.transactions).where(eq(schema.transactions.accountId, accountId))).map((t) => t.id)
  if (txs.length) await db.delete(schema.bankTransferLinks).where(inArray(schema.bankTransferLinks.debitTransactionId, txs))
  await db.delete(schema.transactions).where(eq(schema.transactions.accountId, accountId))
}
beforeAll(async () => {
  await clear()
  await db.delete(schema.payees).where(eq(schema.payees.userId, uid))
  await db.delete(schema.accounts).where(eq(schema.accounts.userId, uid))
  await db.delete(schema.users).where(eq(schema.users.id, uid))
  originalClock = (await db.select().from(schema.settings).where(eq(schema.settings.key, 'clock')))[0]?.value
  // 后台转账用仿真时钟记账；固定到白天，避免夜间大额规则让结果随运行时刻变化
  await db.insert(schema.settings).values({ key: 'clock', value: NOW.toISOString() }).onConflictDoUpdate({ target: schema.settings.key, set: { value: NOW.toISOString() } })
  await db.insert(schema.users).values({ id: uid, name: '后台限额测试' })
  await db.insert(schema.accounts).values({ id: accountId, userId: uid, name: '工资卡', balanceCents: 5_000_000 })
  await db.insert(schema.payees).values({ id: payeeId, userId: uid, name: '小明', alias: '孩子', accountNo: '6222000011112222', bank: '工商银行', createdAt: new Date('2026-01-01') })
})
beforeEach(async () => { await clear(); await db.update(schema.accounts).set({ balanceCents: 5_000_000 }).where(eq(schema.accounts.id, accountId)) })
afterAll(async () => {
  await clear()
  await db.delete(schema.payees).where(eq(schema.payees.userId, uid))
  await db.delete(schema.accounts).where(eq(schema.accounts.userId, uid))
  await db.delete(schema.users).where(eq(schema.users.id, uid))
  if (originalClock === undefined) await db.delete(schema.settings).where(eq(schema.settings.key, 'clock'))
  else await db.update(schema.settings).set({ value: originalClock }).where(eq(schema.settings.key, 'clock'))
})

describe('后台人工转账不受确认单的日累计复查约束', () => {
  it('单笔超过 ¥1,000 也能转：后台没有强验证入口，这条复查是为确认单设计的', async () => {
    const response = await adminTransfer(150_000)
    expect(response.status, await response.clone().text()).toBe(200)
    expect(await balance()).toBe(4_850_000)
  })

  it('当日累计超过 ¥1,000 后继续转账仍然成功', async () => {
    expect((await adminTransfer(80_000)).status).toBe(200)
    expect((await adminTransfer(80_000)).status).toBe(200)
    expect((await adminTransfer(300_000)).status).toBe(200)
    expect(await balance()).toBe(5_000_000 - 460_000)
  })

  it('后台转账写入审计，并且余额不足等业务校验照常生效', async () => {
    expect((await adminTransfer(99_999_999)).status).toBe(500)
    expect(await balance()).toBe(5_000_000)
    const logs = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.userId, uid))
    expect(logs.some((l) => l.type === 'admin_command' && l.payloadJson.includes('"ok":false'))).toBe(true)
  })
})

describe('用户与 Agent 路径的日累计复查保持不变', () => {
  it('没有授权信息：累计超过 ¥1,000 一律拒绝', async () => {
    await expect(settleTransfer(input(150_000), ctx(), NOW)).rejects.toThrow('今日累计转账超过 1000 元')
    expect(await balance()).toBe(5_000_000)
  })

  it('黄色授权不能跨过日累计边界；红色授权可以', async () => {
    await settleTransfer(input(80_000), ctx({ authorization: { level: 'yellow', actionId: 'pa_y1' } }), NOW)
    await expect(settleTransfer(input(30_000), ctx({ authorization: { level: 'yellow', actionId: 'pa_y2' } }), NOW)).rejects.toThrow('今日累计')
    await settleTransfer(input(30_000), ctx({ authorization: { level: 'red', actionId: 'pa_r1' } }), NOW)
    expect(await balance()).toBe(5_000_000 - 110_000)
  })

  it('旧布尔开关、伪造对象与序列化后的授权均无法绕过日累计', async () => {
    await expect(settleTransfer(input(150_000),ctx(),NOW,{adminDirect:true} as never)).rejects.toThrow('今日累计')
    for(const fake of [true,{},JSON.parse(JSON.stringify({}))]) {
      await expect(settleTransfer(input(150_000),ctx({sessionId:'admin'}),NOW,{adminGrant:fake as AdminTransferGrant})).rejects.toThrow('后台转账授权无效')
    }
    expect(await balance()).toBe(5_000_000)
  })

  it('授权绑定账户、用户、渠道、会话和金额，不能移作其他交易', async () => {
    const request=new Request('http://localhost/api/admin')
    for(const [wrongInput,wrongCtx] of [
      [input(160_000),ctx({sessionId:'admin'})],
      [{...input(150_000),fromAccountId:'another'},ctx({sessionId:'admin'})],
      [input(150_000),ctx({userId:'another',sessionId:'admin'})],
      [input(150_000),ctx({channel:'mcp',sessionId:'admin'})],
      [input(150_000),ctx()],
    ] as const) {
      const adminGrant=authorizeAdminTransfer(request,uid,input(150_000))
      await expect(settleTransfer(wrongInput,wrongCtx,NOW,{adminGrant})).rejects.toThrow('后台转账授权无效')
    }
    expect(await balance()).toBe(5_000_000)
  })

  it('通过授权的转账只能执行一次，原子写入后台授权审计', async () => {
    const adminGrant=authorizeAdminTransfer(new Request('http://localhost/api/admin'),uid,input(150_000))
    const receipt=await settleTransfer(input(150_000),ctx({sessionId:'admin'}),NOW,{adminGrant})
    await expect(settleTransfer(input(150_000),ctx({sessionId:'admin'}),NOW,{adminGrant})).rejects.toThrow('已使用')
    expect(await balance()).toBe(4_850_000)
    const logs=await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.userId,uid))
    expect(logs.some(log=>log.payloadJson.includes(receipt.transactionId)&&log.payloadJson.includes('request_bound_admin_grant'))).toBe(true)
  })

  it('后台凭据错误不能签发授权，授权过期也不能使用', async () => {
    const old=env.ADMIN_TOKEN
    try {
      env.ADMIN_TOKEN='private-test-token-at-least-24-chars'
      expect(()=>authorizeAdminTransfer(new Request('http://localhost/api/admin'),uid,input(150_000))).toThrow('后台转账凭据无效')
      const adminGrant=authorizeAdminTransfer(new Request('http://localhost/api/admin',{headers:{authorization:`Bearer ${env.ADMIN_TOKEN}`}}),uid,input(150_000))
      const clock=vi.spyOn(Date,'now').mockReturnValue(Date.now()+61_000)
      try { await expect(settleTransfer(input(150_000),ctx({sessionId:'admin'}),NOW,{adminGrant})).rejects.toThrow('后台转账授权无效') }
      finally { clock.mockRestore() }
    } finally { env.ADMIN_TOKEN=old }
    expect(await balance()).toBe(5_000_000)
  })
})
