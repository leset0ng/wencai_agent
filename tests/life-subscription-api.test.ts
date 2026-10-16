import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { db, schema } from '#/server/db/client'
import { Route } from '#/routes/api/payments'
import { UnauthorizedError } from '#/server/session'
const {session}=vi.hoisted(()=>({session:vi.fn()}))
vi.mock('#/server/session',async(importOriginal)=>({...await importOriginal<typeof import('#/server/session')>(),requireSession:session}))
const owner='u_life_api',other='u_life_other'
const handler=(Route.options.server!.handlers as {POST:(c:{request:Request})=>Promise<Response>}).POST
const getHandler=(Route.options.server!.handlers as {GET:(c:{request:Request})=>Promise<Response>}).GET
const request=(subscriptionId:string)=>new Request('http://localhost/api/payments',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tool:'cancel_subscription',args:{subscriptionId}})})
beforeAll(async()=>{
  await db.insert(schema.users).values([owner,other].map(id=>({id,name:id})))
  await db.insert(schema.subscriptions).values([{id:'life_own_sub',userId:owner,merchant:'本人测试会员',amountCents:2500,cycle:'monthly',status:'active'},{id:'life_other_sub',userId:other,merchant:'其他用户私密订阅',amountCents:9900,cycle:'yearly',status:'active'}])
})
afterAll(async()=>{
  await db.delete(schema.pendingActions).where(inArray(schema.pendingActions.userId,[owner,other]))
  await db.delete(schema.subscriptions).where(inArray(schema.subscriptions.userId,[owner,other]))
  await db.delete(schema.users).where(inArray(schema.users.id,[owner,other]))
})
describe('生活页原生订阅管理入口',()=>{
  it('订单与订阅查询只采用登录身份，不能用查询参数越权',async()=>{
    session.mockResolvedValue({userId:owner,userName:owner,sessionId:'life-api'})
    const res=await getHandler({request:new Request(`http://localhost/api/payments?view=life&userId=${other}`)})
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const out=await res.json()
    expect(out.orders).toEqual([])
    expect(out.subscriptions.map((s:{id:string})=>s.id)).toEqual(['life_own_sub'])
    expect(JSON.stringify(out)).not.toContain('其他用户私密订阅')
  })
  it('未登录无法读取生活订单及订阅',async()=>{
    session.mockRejectedValue(new UnauthorizedError())
    expect((await getHandler({request:new Request('http://localhost/api/payments?view=life')})).status).toBe(401)
  })
  it('点击取消只创建本人确认单，不直接改变订阅',async()=>{
    session.mockResolvedValue({userId:owner,userName:owner,sessionId:'life-api'})
    const res=await handler({request:request('life_own_sub')})
    expect(res.status).toBe(200)
    const out=await res.json()
    expect(out.status).toBe('needs_confirmation')
    expect(out.summary.title).toBe('确认取消订阅')
    expect(out.summary.fields.some((item:{value:string})=>item.value==='本人测试会员')).toBe(true)
    const [stored]=await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.id,'life_own_sub'))
    expect(stored.status).toBe('active')
  })
  it('不能取消或获知其他用户的订阅',async()=>{
    session.mockResolvedValue({userId:owner,userName:owner,sessionId:'life-api'})
    const res=await handler({request:request('life_other_sub')})
    const out=await res.json()
    expect(out.status).toBe('error')
    expect(JSON.stringify(out)).not.toContain('其他用户私密订阅')
    expect((await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.id,'life_other_sub')))[0].status).toBe('active')
  })
  it('未登录无法调用取消入口',async()=>{
    session.mockRejectedValue(new UnauthorizedError())
    expect((await handler({request:request('life_own_sub')})).status).toBe(401)
  })
})
