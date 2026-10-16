import { randomUUID } from 'node:crypto'
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { db, schema, type DB } from '#/server/db/client'
import { LIFE_PRODUCTS } from '#/lib/life-market'
import type { LifeDelivery, LifeOrder, LifeSubscription } from '#/lib/life-commerce'
import type { AgentContext } from '#/server/agent/context'
import { assertDebitAccount } from '#/server/cards/service'
import { nextSubscriptionCharge, notify } from '#/server/automation/service'
import { withUserExecutionLock } from '#/server/confirm/lock'
import { auditInTransaction } from '#/server/audit/log'

const DAY=86400_000
export const lifePeriodEnd=(date:Date,cycle:string)=>new Date(nextSubscriptionCharge(new Date(date.getTime()+8*3600_000),cycle).getTime()-8*3600_000)
type Tx=Parameters<Parameters<DB['transaction']>[0]>[0]
let ready:Promise<void>|undefined
export function ensureLifeSchema() {
  return ready??=(async()=>{
    await db.$client.execute(`CREATE TABLE IF NOT EXISTS bank_life_orders (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,action_id TEXT NOT NULL UNIQUE,product_id TEXT NOT NULL,quantity INTEGER NOT NULL,amount_cents INTEGER NOT NULL,account_id TEXT NOT NULL,transaction_id TEXT NOT NULL UNIQUE,delivery_json TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,dispatch_at INTEGER NOT NULL,delivery_at INTEGER NOT NULL,refund_due_at INTEGER,refunded_at INTEGER,refund_reason TEXT)`)
    await db.$client.execute(`CREATE TABLE IF NOT EXISTS bank_life_subscriptions (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,action_id TEXT NOT NULL UNIQUE,product_id TEXT NOT NULL,account_id TEXT NOT NULL,amount_cents INTEGER NOT NULL,period_end INTEGER NOT NULL,next_charge_at INTEGER,renewals_left INTEGER NOT NULL,renewal_status TEXT NOT NULL,created_at INTEGER NOT NULL,authorization_expires_at INTEGER NOT NULL)`)
  })().catch(e=>{ready=undefined;throw e})
}
export function lifeProduct(id:string,kind?:'goods'|'subscription') {
  const product=LIFE_PRODUCTS.find(p=>p.id===id&&(!kind||p.kind===kind))
  if(!product)throw new Error('商品或服务不存在，请重新查询商城目录')
  return product
}
export function deliveryDates(delivery:LifeDelivery,now:Date) {
  const deliveryAt=delivery.mode==='scheduled'?new Date(delivery.arriveAt??''):new Date(now.getTime()+2*DAY)
  if(!Number.isFinite(deliveryAt.getTime())||deliveryAt.getTime()<now.getTime()+2*DAY||deliveryAt.getTime()>now.getTime()+90*DAY)throw new Error('预约送达时间须在北京时间当前时刻至少48小时后、90天内')
  return {deliveryAt,dispatchAt:new Date(deliveryAt.getTime()-2*DAY)}
}
function authorized(ctx:AgentContext) { if(!ctx.authorization)throw new Error('请先核对确认并完成安全验证'); return ctx.authorization.actionId }
async function debit(tx:Tx,ctx:AgentContext,accountId:string,cents:number,id:string,counterparty:string,category:string,now:Date) {
  if(!Number.isSafeInteger(cents)||cents<=0)throw new Error('扣款金额无效')
  const [user]=await tx.select().from(schema.users).where(eq(schema.users.id,ctx.userId))
  if(!user||user.lockedUntil&&user.lockedUntil>new Date())throw new Error('账户当前不可扣款')
  const [card]=await tx.select().from(schema.cards).where(and(eq(schema.cards.accountId,accountId),eq(schema.cards.userId,ctx.userId)))
  if(!card||card.kind!=='debit')throw new Error('请选择本人储蓄卡付款')
  await assertDebitAccount(tx,accountId)
  const start=new Date(Math.floor((now.getTime()+8*3600_000)/DAY)*DAY-8*3600_000)
  const spent=await tx.select().from(schema.transactions).where(and(eq(schema.transactions.accountId,accountId),gte(schema.transactions.occurredAt,start),sql`${schema.transactions.occurredAt}<${start.getTime()+DAY}`))
  if(spent.reduce((sum,t)=>sum+Math.max(0,-t.amountCents),0)+cents>card.dailyLimitCents)throw new Error('本次扣款超过银行卡每日支出限额')
  const [account]=await tx.update(schema.accounts).set({balanceCents:sql`${schema.accounts.balanceCents}-${cents}`}).where(and(eq(schema.accounts.id,accountId),eq(schema.accounts.userId,ctx.userId),gte(schema.accounts.balanceCents,cents))).returning()
  if(!account)throw new Error('付款账户余额不足，未扣款')
  await tx.insert(schema.transactions).values({id,accountId,amountCents:-cents,counterparty,category,occurredAt:now})
}
export async function buyLifeProduct(ctx:AgentContext,a:{productId:string;quantity:number;fromAccountId:string;delivery:LifeDelivery;deliveryAt:string;dispatchAt:string;amountCents:number},now:Date) {
  await ensureLifeSchema(); const actionId=authorized(ctx),product=lifeProduct(a.productId,'goods')
  if(!Number.isInteger(a.quantity)||a.quantity<1||a.quantity>20||a.amountCents!==Math.round(product.price*100)*a.quantity)throw new Error('商品价格或数量已变化，请重新下单')
  const deliveryAt=new Date(a.deliveryAt),dispatchAt=new Date(a.dispatchAt)
  if(deliveryAt<=now||!Number.isFinite(dispatchAt.getTime()))throw new Error('送达时间已过，请重新下单')
  return db.transaction(async tx=>{
    const [known]=await tx.select().from(schema.bankLifeOrders).where(and(eq(schema.bankLifeOrders.actionId,actionId),eq(schema.bankLifeOrders.userId,ctx.userId)))
    if(known)return {orderId:known.id,status:known.status,duplicate:true}
    const id=`order_${randomUUID()}`,transactionId=`tx_${id}`
    await debit(tx,ctx,a.fromAccountId,a.amountCents,transactionId,product.name,'购物',now)
    await tx.insert(schema.bankLifeOrders).values({id,userId:ctx.userId,actionId,productId:product.id,quantity:a.quantity,amountCents:a.amountCents,accountId:a.fromAccountId,transactionId,deliveryJson:JSON.stringify(a.delivery),status:'paid',createdAt:now,dispatchAt,deliveryAt})
    await auditInTransaction(tx,ctx,'action_executed',{tool:'buy_life_product',actionId,orderId:id,transactionId,amount:a.amountCents/100})
    return {orderId:id,product:product.name,amount:a.amountCents/100,status:'paid',deliveryAt:deliveryAt.toISOString(),logistics:'文财模拟物流，尚未发货'}
  })
}
const effectiveOrderStatus=(row:typeof schema.bankLifeOrders.$inferSelect,now:Date):LifeOrder['status']=>['paid','shipped','delivered'].includes(row.status)?now>=row.deliveryAt?'delivered':now>=row.dispatchAt?'shipped':'paid':row.status as LifeOrder['status']
export async function listLifeOrders(userId:string,now:Date,orderId?:string):Promise<LifeOrder[]> {
  await ensureLifeSchema()
  const rows=await db.select().from(schema.bankLifeOrders).where(and(eq(schema.bankLifeOrders.userId,userId),orderId?eq(schema.bankLifeOrders.id,orderId):undefined)).orderBy(desc(schema.bankLifeOrders.createdAt)).limit(100)
  const cards=await db.select().from(schema.cards).where(eq(schema.cards.userId,userId))
  return rows.map(row=>{const status=effectiveOrderStatus(row,now);return {id:row.id,productId:row.productId,productName:lifeProduct(row.productId).name,quantity:row.quantity,amount:row.amountCents/100,status,cardLast4:cards.find(c=>c.accountId===row.accountId)?.last4??'',delivery:JSON.parse(row.deliveryJson),createdAt:row.createdAt.toISOString(),dispatchAt:row.dispatchAt.toISOString(),deliveryAt:row.deliveryAt.toISOString(),refundDeadline:new Date(row.deliveryAt.getTime()+7*DAY).toISOString(),refundDueAt:row.refundDueAt?.toISOString()??null,refundedAt:row.refundedAt?.toISOString()??null,refundReason:row.refundReason,canRefund:!['refunded','return_requested'].includes(status)&&now.getTime()<=row.deliveryAt.getTime()+7*DAY,logistics:status==='paid'?'已付款，等待预约发货':status==='shipped'?'文财模拟物流运输中':status==='delivered'?'已按预计时间模拟签收':status==='return_requested'?'退货已受理，预计24小时内完成模拟验收并原路退款':'已原路退款'}})
}
async function refund(tx:Tx,row:typeof schema.bankLifeOrders.$inferSelect,now:Date) {
  if(row.status==='refunded')return
  const [payment]=await tx.select().from(schema.transactions).where(and(eq(schema.transactions.id,row.transactionId),eq(schema.transactions.accountId,row.accountId)))
  if(!payment||payment.amountCents!==-row.amountCents)throw new Error('原支付流水无法核对，退款转人工处理')
  const [account]=await tx.update(schema.accounts).set({balanceCents:sql`${schema.accounts.balanceCents}+${row.amountCents}`}).where(and(eq(schema.accounts.id,row.accountId),eq(schema.accounts.userId,row.userId))).returning()
  if(!account)throw new Error('原付款账户不可接收退款，请联系人工处理')
  await tx.insert(schema.transactions).values({id:`refund_${row.id}`,accountId:row.accountId,amountCents:row.amountCents,counterparty:lifeProduct(row.productId).name,category:'购物退款',reversalOf:row.transactionId,occurredAt:now})
  await tx.update(schema.bankLifeOrders).set({status:'refunded',refundedAt:now,refundDueAt:null}).where(eq(schema.bankLifeOrders.id,row.id))
}
export async function returnLifeOrder(ctx:AgentContext,orderId:string,reason:string,now:Date) {
  await ensureLifeSchema();authorized(ctx)
  return db.transaction(async tx=>{
    const [row]=await tx.select().from(schema.bankLifeOrders).where(and(eq(schema.bankLifeOrders.id,orderId),eq(schema.bankLifeOrders.userId,ctx.userId)))
    if(!row)throw new Error('订单不存在或不属于你')
    if(['return_requested','refunded'].includes(row.status))return {orderId,status:row.status,duplicate:true}
    if(now.getTime()>row.deliveryAt.getTime()+7*DAY)throw new Error('已超过签收后7天退货期，请联系人工客服')
    await tx.update(schema.bankLifeOrders).set({refundReason:reason}).where(eq(schema.bankLifeOrders.id,orderId))
    if(now<row.dispatchAt){await refund(tx,row,now);await auditInTransaction(tx,ctx,'action_executed',{tool:'return_life_order',orderId,status:'refunded',amount:row.amountCents/100});return {orderId,status:'refunded',amount:row.amountCents/100}}
    const due=new Date(now.getTime()+DAY)
    await tx.update(schema.bankLifeOrders).set({status:'return_requested',refundDueAt:due}).where(eq(schema.bankLifeOrders.id,orderId))
    await auditInTransaction(tx,ctx,'action_executed',{tool:'return_life_order',orderId,status:'return_requested',refundDueAt:due.toISOString()})
    return {orderId,status:'return_requested',amount:row.amountCents/100,refundDueAt:due.toISOString(),message:'模拟物流将在24小时内完成退货验收后原路退款'}
  })
}
export async function listLifeSubscriptions(userId:string,now:Date):Promise<LifeSubscription[]> {
  await ensureLifeSchema()
  const [subs,meta,cards]=await Promise.all([db.select().from(schema.subscriptions).where(eq(schema.subscriptions.userId,userId)),db.select().from(schema.bankLifeSubscriptions).where(eq(schema.bankLifeSubscriptions.userId,userId)),db.select().from(schema.cards).where(eq(schema.cards.userId,userId))])
  return subs.map(s=>{const item=meta.find(m=>m.id===s.id);return {id:s.id,merchant:s.merchant,amount:s.amountCents/100,cycle:s.cycle,status:s.status,...(item?{productId:item.productId,cardLast4:cards.find(c=>c.accountId===item.accountId)?.last4,periodEnd:item.periodEnd.toISOString(),nextChargeAt:s.status==='active'&&item.renewalStatus==='active'?item.nextChargeAt?.toISOString()??null:null,renewalsLeft:item.renewalsLeft,renewalStatus:s.status==='cancelled'?'stopped':item.renewalStatus,serviceStatus:now<item.periodEnd?'active' as const:'expired' as const}:{})}})
}
export async function subscribeLifeService(ctx:AgentContext,a:{productId:string;fromAccountId:string;autoRenew:boolean;renewals:number;amountCents:number},now:Date) {
  await ensureLifeSchema();const actionId=authorized(ctx),product=lifeProduct(a.productId,'subscription'),cycle=product.cycle==='年'?'yearly':'monthly'
  if(a.amountCents!==Math.round(product.price*100)||a.renewals<0||a.renewals>(cycle==='yearly'?1:11)||!Number.isInteger(a.renewals)||!a.autoRenew&&a.renewals!==0)throw new Error('订阅价格或续费授权无效')
  return db.transaction(async tx=>{
    const [known]=await tx.select().from(schema.bankLifeSubscriptions).where(and(eq(schema.bankLifeSubscriptions.actionId,actionId),eq(schema.bankLifeSubscriptions.userId,ctx.userId)))
    if(known)return {subscriptionId:known.id,duplicate:true}
    const current=await tx.select().from(schema.bankLifeSubscriptions).where(and(eq(schema.bankLifeSubscriptions.userId,ctx.userId),eq(schema.bankLifeSubscriptions.productId,product.id)))
    if(current.some(s=>s.periodEnd>now))throw new Error('该服务的已付费有效期尚未结束，请先查询现有订阅，勿重复扣费')
    const id=`sub_life_${randomUUID()}`,periodEnd=lifePeriodEnd(now,cycle),renewals=a.autoRenew?a.renewals:0
    await debit(tx,ctx,a.fromAccountId,a.amountCents,`tx_${id}`,product.name,'订阅',now)
    await tx.insert(schema.subscriptions).values({id,userId:ctx.userId,merchant:product.name,amountCents:a.amountCents,cycle,status:'active',lastChargedAt:now,remindDays:3})
    await tx.insert(schema.bankLifeSubscriptions).values({id,userId:ctx.userId,actionId,productId:product.id,accountId:a.fromAccountId,amountCents:a.amountCents,periodEnd,nextChargeAt:renewals?periodEnd:null,renewalsLeft:renewals,renewalStatus:renewals?'active':'stopped',createdAt:now,authorizationExpiresAt:new Date(now.getTime()+366*DAY)})
    await auditInTransaction(tx,ctx,'action_executed',{tool:'subscribe_life_service',subscriptionId:id,actionId,amount:product.price,renewals})
    return {subscriptionId:id,merchant:product.name,amount:product.price,status:'active',periodEnd:periodEnd.toISOString(),autoRenew:!!renewals,renewalsLeft:renewals}
  })
}
export async function cancelLifeSubscription(ctx:AgentContext,id:string) {
  await ensureLifeSchema()
  return db.transaction(async tx=>{
    const [sub]=await tx.select().from(schema.subscriptions).where(and(eq(schema.subscriptions.id,id),eq(schema.subscriptions.userId,ctx.userId)))
    if(!sub)throw new Error('订阅不存在')
    await tx.update(schema.subscriptions).set({status:'cancelled'}).where(eq(schema.subscriptions.id,id))
    await tx.update(schema.bankLifeSubscriptions).set({nextChargeAt:null,renewalsLeft:0,renewalStatus:'stopped'}).where(and(eq(schema.bankLifeSubscriptions.id,id),eq(schema.bankLifeSubscriptions.userId,ctx.userId)))
    await auditInTransaction(tx,ctx,'action_executed',{tool:'cancel_subscription',subscriptionId:id})
    return {subscriptionId:id,status:'cancelled',message:'后续扣费已停止，已付费服务保留至有效期结束'}
  })
}
export async function lifeSubscriptionChangeSummary(userId:string,id:string,action:string,remindDays?:number) {
  const sub=(await listLifeSubscriptions(userId,new Date())).find(s=>s.id===id)
  if(!sub)throw new Error('订阅不存在')
  return {title:action==='cancel'?'确认取消订阅':'确认设置提醒',fields:[{label:'商户',value:sub.merchant},{label:'金额',value:`¥${sub.amount.toFixed(2)} / ${sub.cycle==='monthly'?'月':'年'}`},...(sub.periodEnd?[{label:'已付费有效期',value:sub.periodEnd}]:[]),...(action==='cancel'?[{label:'取消后',value:'停止后续扣费，已付费服务保留至有效期结束，不退当期费用'}]:remindDays?[{label:'提前提醒',value:`${remindDays} 天`}]:[])]}
}
/** Worker only: deterministic ledger IDs and one transaction protect retries and concurrent ticks. */
export async function runLifeAutomation(userId:string,now:Date) {
  await ensureLifeSchema()
  return withUserExecutionLock(userId,async()=>{
    const ctx:AgentContext={userId,sessionId:'life-worker',channel:'web'}
    const orders=await db.select().from(schema.bankLifeOrders).where(eq(schema.bankLifeOrders.userId,userId))
    for(const order of orders)await db.transaction(async tx=>{
      const [current]=await tx.select().from(schema.bankLifeOrders).where(and(eq(schema.bankLifeOrders.id,order.id),eq(schema.bankLifeOrders.userId,userId)))
      if(current.status==='return_requested'&&current.refundDueAt&&current.refundDueAt<=now){await refund(tx,current,now);await auditInTransaction(tx,ctx,'action_executed',{tool:'life_return_settlement',orderId:current.id,amount:current.amountCents/100})}
      else if(['paid','shipped'].includes(current.status))await tx.update(schema.bankLifeOrders).set({status:effectiveOrderStatus(current,now)}).where(eq(schema.bankLifeOrders.id,current.id))
    })
    const subs=await db.select().from(schema.bankLifeSubscriptions).where(and(eq(schema.bankLifeSubscriptions.userId,userId),eq(schema.bankLifeSubscriptions.renewalStatus,'active')))
    for(const candidate of subs) {
      if(!candidate.nextChargeAt||candidate.nextChargeAt>now)continue
      try{await db.transaction(async tx=>{
        const [s]=await tx.select().from(schema.bankLifeSubscriptions).where(eq(schema.bankLifeSubscriptions.id,candidate.id))
        const [base]=await tx.select().from(schema.subscriptions).where(and(eq(schema.subscriptions.id,s.id),eq(schema.subscriptions.userId,userId)))
        if(!base||base.status!=='active'||s.renewalStatus!=='active'||!s.nextChargeAt||s.nextChargeAt>now)return
        if(!s.renewalsLeft||now>s.authorizationExpiresAt||now.getTime()-s.nextChargeAt.getTime()>DAY)throw new Error('续费授权已结束或错过扣费时限，请重新核对订阅')
        const product=lifeProduct(s.productId,'subscription')
        if(s.amountCents!==Math.round(product.price*100))throw new Error('服务价格变化，需要重新确认续费授权')
        const due=s.nextChargeAt,next=lifePeriodEnd(due,base.cycle),left=s.renewalsLeft-1
        await debit(tx,ctx,s.accountId,s.amountCents,`renew_${s.id}_${due.getTime()}`,product.name,'订阅',now)
        await tx.update(schema.subscriptions).set({lastChargedAt:due}).where(eq(schema.subscriptions.id,s.id))
        await tx.update(schema.bankLifeSubscriptions).set({periodEnd:next,nextChargeAt:left?next:null,renewalsLeft:left,renewalStatus:left?'active':'stopped'}).where(eq(schema.bankLifeSubscriptions.id,s.id))
        await auditInTransaction(tx,ctx,'action_executed',{tool:'life_subscription_renewal',subscriptionId:s.id,amount:s.amountCents/100,due:due.toISOString()})
      })}catch(e){
        await db.update(schema.bankLifeSubscriptions).set({renewalStatus:'past_due',nextChargeAt:null}).where(and(eq(schema.bankLifeSubscriptions.id,candidate.id),eq(schema.bankLifeSubscriptions.userId,userId),eq(schema.bankLifeSubscriptions.renewalStatus,'active')))
        await notify(userId,'subscription','订阅续费已暂停',e instanceof Error?e.message:'扣费失败，请核对订阅',`life-renewal-failed:${candidate.id}:${candidate.nextChargeAt.getTime()}`)
      }
    }
  })
}
