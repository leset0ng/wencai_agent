import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { auth, db, schema } from '#/server/db/client'
import { ensureCardPasswordSchema, hashCardPassword } from '#/server/cards/password'
import { ensureCardNumberSchema } from '#/server/cards/numbers'
import { ensureCardSchema } from '#/server/cards/service'
import { runBankTool } from '#/server/tools/runner'
import { resolveTool } from '#/server/tools/bank'
import { confirmPending } from '#/server/confirm/pending'
import { createSecureRequest, submitSecureRequest, consumeSecureResult, secureRequestInfo } from '#/server/security/operation'
import { beginDemoBiometric } from '#/server/auth/demo-biometric'
import { buyLifeProduct, cancelLifeSubscription, deliveryDates, ensureLifeSchema, lifePeriodEnd, listLifeOrders, listLifeSubscriptions, returnLifeOrder, runLifeAutomation, runLifeRenewalsThrough } from '#/server/life/service'
import { Route as adminRoute } from '#/routes/api/admin'
import { advanceSimulationClock } from '#/server/tools/bank-extended'
import { availableBankTools } from '#/server/agent/tools'
import { syncWorkerClock } from '#/server/tools/jobs'
import { startPlan } from '#/server/executor/service'
const uid='life_customer',other='life_other',account='life_account',card='life_card',now=new Date('2026-10-16T10:00:00+08:00'),DAY=86400_000
const ctx={userId:uid,sessionId:'life-browser',channel:'web' as const}
let previousClock:string|undefined
let previousClockMode:string|undefined
const delivery={recipient:'测试收件人',phone:'13900001111',address:'测试城市测试街道1号',mode:'scheduled' as const,arriveAt:new Date(now.getTime()+4*DAY).toISOString()}
async function clear(){
  await db.delete(schema.bankLifeOrders).where(eq(schema.bankLifeOrders.userId,uid));await db.delete(schema.bankLifeSubscriptions).where(eq(schema.bankLifeSubscriptions.userId,uid));await db.delete(schema.subscriptions).where(eq(schema.subscriptions.userId,uid))
  await db.delete(schema.transactions).where(eq(schema.transactions.accountId,account));await db.delete(schema.bankSecureRequests).where(eq(schema.bankSecureRequests.userId,uid));await db.delete(schema.pendingActions).where(eq(schema.pendingActions.userId,uid));await db.delete(schema.bankStepUpCodes).where(eq(schema.bankStepUpCodes.userId,uid))
  await db.update(schema.accounts).set({balanceCents:100000}).where(eq(schema.accounts.id,account));await db.update(schema.cards).set({status:'active',dailyLimitCents:5000000}).where(eq(schema.cards.id,card));await db.update(schema.users).set({lockedUntil:null,failedAuthCount:0}).where(eq(schema.users.id,uid))
}
beforeAll(async()=>{
  await ensureLifeSchema();await ensureCardSchema();await ensureCardNumberSchema();await ensureCardPasswordSchema()
  previousClock=(await db.select().from(schema.settings).where(eq(schema.settings.key,'clock')))[0]?.value
  previousClockMode=(await db.select().from(schema.settings).where(eq(schema.settings.key,'clock_mode')))[0]?.value
  await db.insert(schema.settings).values({key:'clock',value:now.toISOString()}).onConflictDoUpdate({target:schema.settings.key,set:{value:now.toISOString()}})
  await db.insert(schema.users).values([{id:uid,name:'生活测试用户'},{id:other,name:'其他用户'}])
  await db.insert(auth.baUser).values({id:uid,name:'生活测试用户',email:'life@test.local',phoneNumber:'13900001234',phoneNumberVerified:true})
  await db.insert(schema.accounts).values({id:account,userId:uid,name:'生活卡',balanceCents:100000})
  await db.insert(schema.cards).values({id:card,userId:uid,accountId:account,last4:'9123',kind:'debit',status:'active',dailyLimitCents:5000000})
  await db.insert(schema.bankCardProfiles).values({cardId:card,remark:'生活卡'})
  await db.insert(schema.bankCardPasswords).values({cardId:card,userId:uid,passwordHash:hashCardPassword('246810')})
})
beforeEach(async()=>{await clear();await db.update(schema.settings).set({value:now.toISOString()}).where(eq(schema.settings.key,'clock'))})
afterAll(async()=>{
  await clear();await db.delete(schema.bankCardPasswords).where(eq(schema.bankCardPasswords.userId,uid));await db.delete(schema.bankCardNumbers).where(eq(schema.bankCardNumbers.cardId,card));await db.delete(schema.bankCardProfiles).where(eq(schema.bankCardProfiles.cardId,card));await db.delete(schema.cards).where(eq(schema.cards.id,card));await db.delete(schema.accounts).where(eq(schema.accounts.id,account));await db.delete(auth.baUser).where(eq(auth.baUser.id,uid));await db.delete(schema.users).where(inArray(schema.users.id,[uid,other]))
  if(previousClock)await db.update(schema.settings).set({value:previousClock}).where(eq(schema.settings.key,'clock'));else await db.delete(schema.settings).where(eq(schema.settings.key,'clock'))
  if(previousClockMode===undefined)await db.delete(schema.settings).where(eq(schema.settings.key,'clock_mode'));else await db.insert(schema.settings).values({key:'clock_mode',value:previousClockMode}).onConflictDoUpdate({target:schema.settings.key,set:{value:previousClockMode}})
})
async function propose(tool='buy_life_product',args:Record<string,unknown>={}){
  const input=tool==='buy_life_product'?{productId:'cup',quantity:2,cardId:card,delivery,...args}:tool==='subscribe_life_service'?{productId:'video',cardId:card,...args}:args
  const result=await runBankTool(resolveTool(tool)!,input,ctx)
  if(result.status!=='needs_confirmation')throw new Error(JSON.stringify(result))
  return result
}
async function execute(pending:Awaited<ReturnType<typeof propose>>,strong=false){
  const page=await createSecureRequest(ctx,{purpose:'confirm_action',actionId:pending.actionId})
  const stepUp=strong?{method:'fingerprint' as const,...await beginDemoBiometric(uid,`action:${pending.actionId}`,'fingerprint')}:undefined
  const result=await submitSecureRequest(ctx,page.id,{password:'246810',stepUp})
  expect(result).toMatchObject({ok:true})
  return (await consumeSecureResult(ctx,page.id) as {output:Record<string,any>}).output
}
const balance=async()=>(await db.select().from(schema.accounts).where(eq(schema.accounts.id,account)))[0].balanceCents
describe('生活商品真实记账与退款',()=>{
  it('确认前不扣款，独立安全验证后持久购买且确认单不重复执行',async()=>{
    const pending=await propose();expect(await balance()).toBe(100000)
    expect(await confirmPending({ctx,actionId:pending.actionId,resolveTool})).toMatchObject({ok:false,code:'card_password_required'})
    const out=await execute(pending);expect(await balance()).toBe(88200)
    expect(await listLifeOrders(uid,now,out.orderId)).toMatchObject([{productId:'cup',quantity:2,amount:118,status:'paid',cardLast4:'9123'}])
    expect(await confirmPending({ctx,actionId:pending.actionId,resolveTool})).toMatchObject({ok:false,code:'already_used'})
    expect(await balance()).toBe(88200)
    expect(await listLifeOrders(other,now,out.orderId)).toEqual([])
  })
  it('并发重放同一已授权动作只扣一次，金额取自服务端目录',async()=>{
    const dates=deliveryDates(delivery,now),a={productId:'cup',quantity:1,fromAccountId:account,delivery,amountCents:5900,deliveryAt:dates.deliveryAt.toISOString(),dispatchAt:dates.dispatchAt.toISOString()},authorized={...ctx,authorization:{level:'yellow' as const,actionId:'life-replay'}}
    const [one,two]=await Promise.all([buyLifeProduct(authorized,a,now),buyLifeProduct(authorized,a,now)])
    expect(one.orderId).toBe(two.orderId);expect(await balance()).toBe(94100)
    await expect(buyLifeProduct({...authorized,authorization:{level:'yellow',actionId:'bad-price'}},{...a,amountCents:1},now)).rejects.toThrow('价格')
  })
  it('不接受无授权扣款、无效预约及不存在的商品',async()=>{
    expect(()=>deliveryDates({...delivery,arriveAt:new Date(now.getTime()+DAY).toISOString()},now)).toThrow('48小时')
    expect(()=>deliveryDates({...delivery,arriveAt:new Date(now.getTime()+91*DAY).toISOString()},now)).toThrow('90天')
    const bad=await runBankTool(resolveTool('buy_life_product')!,{productId:'fake',quantity:1,cardId:card,delivery,amountCents:1},ctx);expect(bad.status).toBe('error')
    const dates=deliveryDates(delivery,now)
    await expect(buyLifeProduct(ctx,{productId:'cup',quantity:1,fromAccountId:account,delivery,amountCents:5900,deliveryAt:dates.deliveryAt.toISOString(),dispatchAt:dates.dispatchAt.toISOString()},now)).rejects.toThrow('安全验证')
    expect(await balance()).toBe(100000)
  })
  it('执行前余额不足或卡片冻结不会生成订单和部分扣款',async()=>{
    const pending=await propose();await db.update(schema.accounts).set({balanceCents:100}).where(eq(schema.accounts.id,account))
    const page=await createSecureRequest(ctx,{purpose:'confirm_action',actionId:pending.actionId})
    expect(await submitSecureRequest(ctx,page.id,{password:'246810'})).toMatchObject({ok:false,code:'execution_failed'})
    expect(await balance()).toBe(100);expect(await listLifeOrders(uid,now)).toEqual([])
    await db.update(schema.accounts).set({balanceCents:100000}).where(eq(schema.accounts.id,account));const next=await propose();await db.update(schema.cards).set({status:'locked'}).where(eq(schema.cards.id,card))
    const second=await createSecureRequest(ctx,{purpose:'confirm_action',actionId:next.actionId});expect(await submitSecureRequest(ctx,second.id,{password:'246810'})).toMatchObject({ok:false})
    expect(await balance()).toBe(100000);expect(await listLifeOrders(uid,now)).toEqual([])
  })
  it('未发货原路退款，重复申请与并发结算不重复入账',async()=>{
    const out=await execute(await propose()),refund=await propose('return_life_order',{orderId:out.orderId,reason:'不再需要'});expect(await balance()).toBe(88200)
    expect(await execute(refund)).toMatchObject({status:'refunded'});expect(await balance()).toBe(100000)
    await Promise.all([returnLifeOrder({...ctx,authorization:{level:'yellow',actionId:'retry'}},out.orderId,'重试',now),runLifeAutomation(uid,now)])
    expect(await balance()).toBe(100000)
    const rows=await db.select().from(schema.transactions).where(and(eq(schema.transactions.accountId,account),eq(schema.transactions.category,'购物退款')));expect(rows).toHaveLength(1);expect(rows[0].reversalOf).toBeTruthy()
  })
  it('已发货先受理退货，24小时后入账，7天边界与跨用户权限正确',async()=>{
    const out=await execute(await propose()),authorized={...ctx,authorization:{level:'yellow' as const,actionId:'return'}},boundary=new Date(new Date(delivery.arriveAt).getTime()+7*DAY)
    await expect(returnLifeOrder({...authorized,userId:other},out.orderId,'退款',now)).rejects.toThrow('不属于')
    await expect(returnLifeOrder(authorized,out.orderId,'超期',new Date(boundary.getTime()+1))).rejects.toThrow('7天')
    expect(await returnLifeOrder(authorized,out.orderId,'边界退货',boundary)).toMatchObject({status:'return_requested'});expect(await balance()).toBe(88200)
    await runLifeAutomation(uid,new Date(boundary.getTime()+DAY-1));expect(await balance()).toBe(88200)
    await Promise.all([runLifeAutomation(uid,new Date(boundary.getTime()+DAY)),runLifeAutomation(uid,new Date(boundary.getTime()+DAY))]);expect(await balance()).toBe(100000)
    expect((await listLifeOrders(uid,boundary,out.orderId))[0].status).toBe('refunded')
  })
})
describe('订阅开通、有限续费与取消',()=>{
  it('首期扣费、有效期和重复订阅检查，取消不退当期且停止后续扣款',async()=>{
    const out=await execute(await propose('subscribe_life_service'));expect(await balance()).toBe(97500)
    const [sub]=await listLifeSubscriptions(uid,now);expect(sub).toMatchObject({id:out.subscriptionId,status:'active',nextChargeAt:null,serviceStatus:'active'})
    const duplicate=await propose('subscribe_life_service'),page=await createSecureRequest(ctx,{purpose:'confirm_action',actionId:duplicate.actionId});expect(await submitSecureRequest(ctx,page.id,{password:'246810'})).toMatchObject({ok:false,code:'execution_failed'});expect(await balance()).toBe(97500)
    await expect(cancelLifeSubscription({...ctx,userId:other},out.subscriptionId)).rejects.toThrow('不存在')
    await execute(await propose('cancel_subscription',{subscriptionId:out.subscriptionId}));expect((await listLifeSubscriptions(uid,now))[0]).toMatchObject({status:'cancelled',serviceStatus:'active',nextChargeAt:null})
    await runLifeAutomation(uid,new Date(now.getTime()+45*DAY));expect(await balance()).toBe(97500);expect((await listLifeSubscriptions(uid,new Date(now.getTime()+45*DAY)))[0].serviceStatus).toBe('expired')
  })
  it('自动续费须强验证，到期并发只扣一次，取消后不再扣',async()=>{
    const pending=await propose('subscribe_life_service',{autoRenew:true,renewals:2});expect(pending.level).toBe('red')
    const secure=await createSecureRequest(ctx,{purpose:'confirm_action',actionId:pending.actionId});expect(await secureRequestInfo(ctx,secure.id)).toMatchObject({strongRequired:true,passwordRequired:true,singleChoice:false})
    expect(await submitSecureRequest(ctx,secure.id,{password:'246810'})).toMatchObject({ok:false,code:'step_up_required'})
    const out=await execute(pending,true),due=lifePeriodEnd(now,'monthly')
    await Promise.all([runLifeAutomation(uid,due),runLifeAutomation(uid,due)]);expect(await balance()).toBe(95000)
    expect((await listLifeSubscriptions(uid,due))[0].renewalsLeft).toBe(1)
    await execute(await propose('cancel_subscription',{subscriptionId:out.subscriptionId}));await runLifeAutomation(uid,lifePeriodEnd(due,'monthly'));expect(await balance()).toBe(95000)
  })
  it('续费次数用尽停止，冻结卡或迟到不能补扣',async()=>{
    await execute(await propose('subscribe_life_service',{autoRenew:true,renewals:1}),true);const due=lifePeriodEnd(now,'monthly')
    await runLifeAutomation(uid,due);await runLifeAutomation(uid,lifePeriodEnd(due,'monthly'));expect(await balance()).toBe(95000);expect((await listLifeSubscriptions(uid,due))[0]).toMatchObject({renewalsLeft:0,nextChargeAt:null,renewalStatus:'stopped'})
  })
  it.each(['locked','late'] as const)('续费失败暂停而不循环重试：%s',async mode=>{
    await execute(await propose('subscribe_life_service',{autoRenew:true,renewals:2}),true);const due=lifePeriodEnd(now,'monthly')
    if(mode==='locked')await db.update(schema.cards).set({status:'locked'}).where(eq(schema.cards.id,card))
    await runLifeAutomation(uid,mode==='late'?new Date(due.getTime()+2*DAY):due);expect(await balance()).toBe(97500)
    expect((await listLifeSubscriptions(uid,due))[0]).toMatchObject({renewalStatus:'past_due',nextChargeAt:null})
  })
  it('北京时间月末与闰年有效期正确，Agent与渠道白名单可访问',async()=>{
    expect(lifePeriodEnd(new Date('2026-01-31T00:30:00+08:00'),'monthly').toISOString()).toBe(new Date('2026-02-28T00:30:00+08:00').toISOString())
    expect(lifePeriodEnd(new Date('2028-02-29T09:00:00+08:00'),'yearly').toISOString()).toBe(new Date('2029-02-28T09:00:00+08:00').toISOString())
    expect(availableBankTools(ctx).map(t=>t.name)).toEqual(expect.arrayContaining(['buy_life_product','return_life_order','subscribe_life_service','list_life_orders','list_life_subscriptions']))
    expect(availableBankTools({...ctx,channel:'mcp'}).some(t=>t.name==='buy_life_product')).toBe(false)
  })
  it('旧版订阅条款和令牌取消入口也停止续费，单期不会虚构下次扣费',async()=>{
    const one=await execute(await propose('subscribe_life_service'))
    const terms=await runBankTool(resolveTool('get_subscription_terms')!,{subscriptionId:one.subscriptionId},ctx)
    expect(terms).toMatchObject({status:'done',data:{nextChargeAt:null,serviceStatus:'active'}})
    const preview=await runBankTool(resolveTool('preview_subscription_change')!,{subscriptionId:one.subscriptionId,action:'cancel'},ctx)
    if(preview.status!=='done')throw new Error(JSON.stringify(preview))
    const token=preview.data as {confirmationToken:string}
    const p=await propose('commit_subscription_change',{subscriptionId:one.subscriptionId,action:'cancel',confirmationToken:token.confirmationToken})
    expect(await confirmPending({ctx,actionId:p.actionId,resolveTool})).toMatchObject({ok:true})
    expect((await listLifeSubscriptions(uid,now))[0]).toMatchObject({status:'cancelled',nextChargeAt:null,renewalsLeft:0})
  })
  it('生日送礼DAG在购买节点等待验证，确认后完成且扣款一次',async()=>{
    const planned=await startPlan(ctx,{goal:'为生日购买保温杯并预约送达',nodes:[{id:'catalog',kind:'tool',tool:'list_life_catalog',args:{kind:'goods'},dependsOn:[]},{id:'buy',kind:'tool',tool:'buy_life_product',args:{productId:'cup',quantity:1,cardId:card,delivery},dependsOn:['catalog']}]},new Set(availableBankTools(ctx).map(t=>t.name)))
    if(!planned.ok)throw new Error(JSON.stringify(planned))
    expect(planned.state.status).toBe('suspended');expect(await balance()).toBe(100000)
    const actionId=planned.state.nodes.buy.actionId!
    const pending=(await db.select().from(schema.pendingActions).where(eq(schema.pendingActions.id,actionId)))[0]
    await execute({status:'needs_confirmation',actionId,level:pending.level as 'yellow'|'red',summary:JSON.parse(pending.summaryJson),reasons:[],expiresAt:pending.expiresAt.getTime()})
    expect(await balance()).toBe(94100)
    expect((await db.select().from(schema.plans).where(eq(schema.plans.id,planned.state.id)))[0].status).toBe('completed')
    await db.delete(schema.plans).where(eq(schema.plans.id,planned.state.id))
  })
})

describe('后台推进时间：续费按扣费日准时执行，而不是被判迟到', () => {
  const subscribe = async (renewals: number) => (await execute(await propose('subscribe_life_service', { autoRenew: true, renewals }), true)).subscriptionId as string
  const renewalRow = async (subscriptionId: string, due: Date) =>
    (await db.select().from(schema.transactions).where(eq(schema.transactions.id, `renew_${subscriptionId}_${due.getTime()}`)))[0]

  it('推进跨过扣费日几天：续费在扣费日执行一次，流水时间是扣费日，而不是推进后的时间', async () => {
    const id = await subscribe(2), due = lifePeriodEnd(now, 'monthly')
    const result = await runLifeRenewalsThrough(now, new Date(due.getTime() + 5 * DAY))
    expect(result.steps).toBe(1)
    expect(await balance()).toBe(95000)
    expect((await listLifeSubscriptions(uid, due))[0]).toMatchObject({ renewalsLeft: 1, renewalStatus: 'active' })
    expect((await renewalRow(id, due)).occurredAt.getTime()).toBe(due.getTime())
  })

  it('对照：同样的跳跃直接交给 runLifeAutomation，仍然按"迟到不能补扣"暂停（安全约束没有被放宽）', async () => {
    await subscribe(2)
    const due = lifePeriodEnd(now, 'monthly')
    await runLifeAutomation(uid, new Date(due.getTime() + 5 * DAY))
    expect(await balance()).toBe(97500)
    expect((await listLifeSubscriptions(uid, due))[0]).toMatchObject({ renewalStatus: 'past_due', nextChargeAt: null })
  })

  it('一次推进跨过两个扣费日：依次各扣一次，次数用尽后停止', async () => {
    const id = await subscribe(2), due1 = lifePeriodEnd(now, 'monthly'), due2 = lifePeriodEnd(due1, 'monthly')
    const result = await runLifeRenewalsThrough(now, new Date(due2.getTime() + 3 * DAY))
    expect(result.steps).toBe(2)
    expect(await balance()).toBe(92500)
    expect((await listLifeSubscriptions(uid, due2))[0]).toMatchObject({ renewalsLeft: 0, renewalStatus: 'stopped', nextChargeAt: null })
    expect((await renewalRow(id, due1)).occurredAt.getTime()).toBe(due1.getTime())
    expect((await renewalRow(id, due2)).occurredAt.getTime()).toBe(due2.getTime())
  })

  it('没有跨过扣费日时什么都不做；已取消的续费不会被扣', async () => {
    const id = await subscribe(2), due = lifePeriodEnd(now, 'monthly')
    expect(await runLifeRenewalsThrough(now, new Date(due.getTime() - DAY))).toEqual({ steps: 0 })
    expect(await balance()).toBe(97500)
    await execute(await propose('cancel_subscription', { subscriptionId: id }))
    expect(await runLifeRenewalsThrough(new Date(due.getTime() - DAY), new Date(due.getTime() + 5 * DAY))).toEqual({ steps: 0 })
    expect(await balance()).toBe(97500)
  })

  it('时钟是全局的：其他用户的续费同样准时执行，不会因为选中的是别人而被判迟到', async () => {
    const otherAccount = 'life_other_account', otherCard = 'life_other_card', otherSub = 'sub_life_other', due = lifePeriodEnd(now, 'monthly')
    try {
      await db.insert(schema.accounts).values({ id: otherAccount, userId: other, name: '其他人的卡', balanceCents: 50000 })
      await db.insert(schema.cards).values({ id: otherCard, userId: other, accountId: otherAccount, last4: '7788', kind: 'debit', status: 'active', dailyLimitCents: 5000000 })
      await db.insert(schema.subscriptions).values({ id: otherSub, userId: other, merchant: '某视频会员', amountCents: 2500, cycle: 'monthly', status: 'active', lastChargedAt: now, remindDays: 3 })
      await db.insert(schema.bankLifeSubscriptions).values({ id: otherSub, userId: other, actionId: 'pa_life_other', productId: 'video', accountId: otherAccount, amountCents: 2500,
        periodEnd: due, nextChargeAt: due, renewalsLeft: 1, renewalStatus: 'active', createdAt: now, authorizationExpiresAt: new Date(now.getTime() + 366 * DAY) })
      const result = await runLifeRenewalsThrough(now, new Date(due.getTime() + 4 * DAY))
      expect(result.steps).toBe(1)
      expect((await db.select().from(schema.accounts).where(eq(schema.accounts.id, otherAccount)))[0].balanceCents).toBe(47500)
      expect((await db.select().from(schema.bankLifeSubscriptions).where(eq(schema.bankLifeSubscriptions.id, otherSub)))[0]).toMatchObject({ renewalStatus: 'stopped', renewalsLeft: 0 })
    } finally {
      await db.delete(schema.transactions).where(eq(schema.transactions.accountId, otherAccount))
      await db.delete(schema.bankLifeSubscriptions).where(eq(schema.bankLifeSubscriptions.id, otherSub))
      await db.delete(schema.subscriptions).where(eq(schema.subscriptions.id, otherSub))
      await db.delete(schema.cards).where(eq(schema.cards.id, otherCard))
      await db.delete(schema.accounts).where(eq(schema.accounts.id, otherAccount))
    }
  })

  it('系统工具 advance_simulation_clock 同样按扣费日执行（与后台是同一个操作的另一个入口）', async () => {
    const id = await subscribe(2), due = lifePeriodEnd(now, 'monthly'), target = new Date(due.getTime() + 5 * DAY)
    const mode = (await db.select().from(schema.settings).where(eq(schema.settings.key, 'clock_mode')))[0]?.value
    try {
      await advanceSimulationClock.execute({ to: target.toISOString() }, ctx)
      expect(await balance()).toBe(95000)
      expect((await renewalRow(id, due)).occurredAt.getTime()).toBe(due.getTime())
      expect((await listLifeSubscriptions(uid, target))[0]).toMatchObject({ renewalsLeft: 1, renewalStatus: 'active' })
    } finally {
      await db.update(schema.settings).set({ value: now.toISOString() }).where(eq(schema.settings.key, 'clock'))
      if (mode === undefined) await db.delete(schema.settings).where(eq(schema.settings.key, 'clock_mode'))
      else await db.update(schema.settings).set({ value: mode }).where(eq(schema.settings.key, 'clock_mode'))
    }
  })

  it('后台"推进时间"命令端到端：续费被扣一次，时钟落在目标时间，订阅保持有效', async () => {
    const id = await subscribe(2), due = lifePeriodEnd(now, 'monthly'), target = new Date(due.getTime() + 5 * DAY)
    const post = (body: unknown) => (adminRoute.options.server!.handlers as { POST: (c: { request: Request }) => Promise<Response> }).POST({
      request: new Request('http://localhost/api/admin', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-user': uid }, body: JSON.stringify(body) }),
    })
    const mode = (await db.select().from(schema.settings).where(eq(schema.settings.key, 'clock_mode')))[0]?.value
    try {
      const response = await post({ type: 'advanceClock', to: target.toISOString() })
      expect(response.status, await response.clone().text()).toBe(200)
      expect(await balance()).toBe(95000)
      expect((await listLifeSubscriptions(uid, target))[0]).toMatchObject({ renewalsLeft: 1, renewalStatus: 'active' })
      expect((await renewalRow(id, due)).occurredAt.getTime()).toBe(due.getTime())
      expect((await db.select().from(schema.settings).where(eq(schema.settings.key, 'clock')))[0].value).toBe(target.toISOString())
    } finally {
      await db.update(schema.settings).set({ value: now.toISOString() }).where(eq(schema.settings.key, 'clock'))
      if (mode === undefined) await db.delete(schema.settings).where(eq(schema.settings.key, 'clock_mode'))
      else await db.update(schema.settings).set({ value: mode }).where(eq(schema.settings.key, 'clock_mode'))
    }
  })
})


describe('续费推进的隔离、原子性和大队列',()=>{
  const due=lifePeriodEnd(now,'monthly'),target=new Date(due.getTime()+4*DAY)
  async function queue(count:number) {
    await db.update(schema.accounts).set({balanceCents:2_000_000}).where(eq(schema.accounts.id,account))
    const ids=Array.from({length:count},(_,i)=>`review_queue_${String(i).padStart(4,'0')}`)
    for(let start=0;start<ids.length;start+=100) {
      const batch=ids.slice(start,start+100)
      await db.insert(schema.subscriptions).values(batch.map(id=>({id,userId:uid,merchant:'某视频会员',amountCents:2500,cycle:'monthly' as const,status:'active' as const,lastChargedAt:now,remindDays:3})))
      await db.insert(schema.bankLifeSubscriptions).values(batch.map(id=>({id,userId:uid,actionId:`pa_${id}`,productId:'video',accountId:account,amountCents:2500,periodEnd:due,nextChargeAt:due,renewalsLeft:1,renewalStatus:'active',createdAt:now,authorizationExpiresAt:new Date(now.getTime()+366*DAY)})))
    }
    return ids
  }
  const currentClock=async()=>(await db.select().from(schema.settings).where(eq(schema.settings.key,'clock')))[0].value
  const renewals=async()=>db.select().from(schema.transactions).where(eq(schema.transactions.accountId,account))

  it('最前面的孤立订阅停止，其他用户的续费仍在扣费日执行',async()=>{
    const [orphan]=await queue(2)
    await db.delete(schema.subscriptions).where(eq(schema.subscriptions.id,orphan))
    await db.update(schema.bankLifeSubscriptions).set({userId:other}).where(eq(schema.bankLifeSubscriptions.id,orphan))
    try {
      expect(await runLifeRenewalsThrough(now,target)).toEqual({steps:2})
      expect(await balance()).toBe(1_997_500)
      expect((await renewals()).map(r=>r.occurredAt.toISOString())).toEqual([due.toISOString()])
      expect((await db.select().from(schema.bankLifeSubscriptions).where(eq(schema.bankLifeSubscriptions.id,orphan)))[0]).toMatchObject({renewalStatus:'stopped',nextChargeAt:null})
      expect(await currentClock()).toBe(target.toISOString())
    } finally { await db.delete(schema.bankLifeSubscriptions).where(eq(schema.bankLifeSubscriptions.id,orphan)) }
  })

  it.each(['ledger','clock'] as const)('数据库异常（%s）时，前面扣款、状态、审计和时钟一起回滚',async(failure)=>{
    const [first,broken]=await queue(2)
    const previousMode=(await db.select().from(schema.settings).where(eq(schema.settings.key,'clock_mode')))[0]?.value
    const beforeAudit=(await db.select().from(schema.auditLogs)).length
    await db.$client.execute(failure==='ledger'
      ? `CREATE TRIGGER review_renewal_fault BEFORE INSERT ON transactions WHEN NEW.id='renew_${broken}_${due.getTime()}' BEGIN SELECT RAISE(ABORT,'review injected renewal failure'); END`
      : "CREATE TRIGGER review_renewal_fault BEFORE UPDATE ON settings WHEN NEW.key='clock' BEGIN SELECT RAISE(ABORT,'review injected clock failure'); END")
    try {
      await expect(runLifeRenewalsThrough(now,target)).rejects.toThrow('Failed query')
      expect(await balance()).toBe(2_000_000)
      expect(await renewals()).toHaveLength(0)
      expect(await currentClock()).toBe(now.toISOString())
      expect((await db.select().from(schema.settings).where(eq(schema.settings.key,'clock_mode')))[0]?.value).toBe(previousMode)
      expect((await db.select().from(schema.auditLogs)).length).toBe(beforeAudit)
      expect((await db.select().from(schema.bankLifeSubscriptions).where(eq(schema.bankLifeSubscriptions.id,first)))[0]).toMatchObject({renewalsLeft:1,nextChargeAt:due,renewalStatus:'active'})
    } finally { await db.$client.execute('DROP TRIGGER IF EXISTS review_renewal_fault') }
    expect(await runLifeRenewalsThrough(now,target)).toEqual({steps:2})
    expect(await balance()).toBe(1_995_000)
  })

  it('一次余额不足只暂停该订阅，后续订阅照常扣款',async()=>{
    const [empty]=await queue(2),emptyAccount='review_empty_account',emptyCard='review_empty_card'
    await db.insert(schema.accounts).values({id:emptyAccount,userId:uid,name:'余额不足卡',balanceCents:0})
    await db.insert(schema.cards).values({id:emptyCard,userId:uid,accountId:emptyAccount,last4:'1110',kind:'debit',status:'active',dailyLimitCents:5000000})
    await db.update(schema.bankLifeSubscriptions).set({accountId:emptyAccount}).where(eq(schema.bankLifeSubscriptions.id,empty))
    try {
      expect(await runLifeRenewalsThrough(now,target)).toEqual({steps:2})
      expect(await balance()).toBe(1_997_500)
      expect((await db.select().from(schema.bankLifeSubscriptions).where(eq(schema.bankLifeSubscriptions.id,empty)))[0]).toMatchObject({renewalStatus:'past_due',nextChargeAt:null})
      expect(await renewals()).toHaveLength(1)
    } finally { await db.delete(schema.cards).where(eq(schema.cards.id,emptyCard));await db.delete(schema.accounts).where(eq(schema.accounts.id,emptyAccount)) }
  })

  it('续费不反复推进订单；时钟提交后其他任务失败会显式报告，而不是谎报时钟未推进',async()=>{
    await queue(2)
    await db.insert(schema.bankLifeOrders).values({id:'review_broken_refund',userId:uid,actionId:'pa_review_broken_refund',productId:'cup',quantity:1,amountCents:5900,accountId:account,transactionId:'missing_payment',deliveryJson:JSON.stringify(delivery),status:'return_requested',createdAt:now,dispatchAt:now,deliveryAt:now,refundDueAt:due})
    const result=await advanceSimulationClock.execute({to:target.toISOString()},ctx)
    expect(result).toMatchObject({now:target.toISOString(),renewal:{steps:2},jobs:[],jobsError:'原支付流水无法核对，退款转人工处理'})
    expect(await balance()).toBe(1_995_000)
    expect(await currentClock()).toBe(target.toISOString())
    expect((await db.select().from(schema.bankLifeOrders).where(eq(schema.bankLifeOrders.id,'review_broken_refund')))[0].status).toBe('return_requested')
  })

  it('超过500笔也全部处理，不能静默截断或变成迟到',async()=>{
    await queue(501)
    expect(await runLifeRenewalsThrough(now,target)).toEqual({steps:501})
    expect(await balance()).toBe(2_000_000-501*2500)
    const rows=await renewals()
    expect(rows).toHaveLength(501)
    expect(rows.every(r=>r.occurredAt.getTime()===due.getTime())).toBe(true)
    expect((await db.select().from(schema.bankLifeSubscriptions).where(eq(schema.bankLifeSubscriptions.userId,uid))).every(s=>s.renewalStatus==='stopped')).toBe(true)
  },30_000)

  it('并发推进只允许一个请求使用旧时钟，不会重复扣费或把时钟倒回',async()=>{
    await queue(1)
    const later=new Date(target.getTime()+DAY)
    const results=await Promise.allSettled([runLifeRenewalsThrough(now,target),runLifeRenewalsThrough(now,later)])
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1)
    expect(results.filter(r=>r.status==='rejected')).toHaveLength(1)
    expect(await balance()).toBe(1_997_500)
    expect(await renewals()).toHaveLength(1)
    expect([target.toISOString(),later.toISOString()]).toContain(await currentClock())
  })

  it('worker 使用推进前的系统时间也不能覆盖已提交的手动时钟',async()=>{
    await queue(1)
    await runLifeRenewalsThrough(now,target)
    expect(await syncWorkerClock(now)).toEqual(target)
    expect(await currentClock()).toBe(target.toISOString())
    expect(await balance()).toBe(1_997_500)
  })

  it('按整条请求处理失败时不修改手动时钟模式，无效时间也不修改任何数据',async()=>{
    await expect(runLifeRenewalsThrough(now,new Date('invalid'))).rejects.toThrow('有效日期')
    await expect(runLifeRenewalsThrough(now,now)).rejects.toThrow('有效日期')
    expect(await currentClock()).toBe(now.toISOString())
  })
})
