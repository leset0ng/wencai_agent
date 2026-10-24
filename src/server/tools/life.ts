import { z } from 'zod'
import { defineBankTool } from './define'
import { LIFE_PRODUCTS } from '#/lib/life-market'
import { cardLabel, ownProfile, resolveCard } from '#/server/cards/service'
import { buyLifeProduct, deliveryDates, lifeProduct, listLifeOrders, listLifeSubscriptions, returnLifeOrder, subscribeLifeService } from '#/server/life/service'
import { simNow } from './jobs'
import { lifeTime } from '#/lib/life-commerce'
const funding={cardId:z.string().optional().describe('本人储蓄卡ID，与fromCardQuery任选其一'),fromCardQuery:z.string().optional().describe('银行卡备注或尾号，重名须询问具体尾号')}
const delivery=z.object({recipient:z.string().trim().min(1).max(50),phone:z.string().regex(/^1\d{10}$/),address:z.string().trim().min(5).max(200),mode:z.enum(['immediate','scheduled']),arriveAt:z.string().datetime({offset:true}).optional().describe('预约送达北京时间，包含+08:00时区，至少48小时后、90天内')})
const purchase=z.object({productId:z.string(),quantity:z.number().int().min(1).max(20).default(1),...funding,delivery})
type Purchase=z.infer<typeof purchase>&{fromAccountId:string;amountCents:number;deliveryAt:string;dispatchAt:string;cardName:string}
const subscription=z.object({productId:z.string(),...funding,autoRenew:z.boolean().default(false),renewals:z.number().int().min(1).max(11).default(3).describe('自动续费次数上限：月费最多11次，年费最多1次，授权最长366天')})
type Subscription=z.infer<typeof subscription>&{fromAccountId:string;amountCents:number;cardName:string}
async function source(userId:string,a:{cardId?:string;fromCardQuery?:string}) {
  if(!a.cardId&&!a.fromCardQuery)throw new Error('请先选择付款储蓄卡')
  const card=a.cardId?await ownProfile(userId,a.cardId):await resolveCard(userId,a.fromCardQuery!,'debit')
  if(card.kind!=='debit'||card.status!=='active')throw new Error('请选择正常状态的本人储蓄卡')
  return card
}
export const listLifeCatalog=defineBankTool({name:'list_life_catalog',kind:'read',catalogFields:['name','title'],baseRisk:'green',description:'查询生活商城可购买商品、可开通订阅服务及价格/周期。购买在文财模拟银行真实记账扣款，物流与会员权益为沙箱模拟，不联系外部商家。生日送礼等任务可选商品并预约送达。',inputSchema:z.object({kind:z.enum(['goods','subscription']).optional()}),execute:async a=>({products:LIFE_PRODUCTS.filter(p=>!a.kind||p.kind===a.kind),rules:{delivery:'立即送出预计48小时送达；预约48小时至90天内',returns:'未发货原路退款；发货后至签收后7天可退货，24小时模拟验收退款',subscriptions:'先付一期，自动续费须明确授权次数与上限，可取消后续扣费'}})})
export const purchaseLifeProduct=defineBankTool({name:'buy_life_product',kind:'write',baseRisk:'yellow',description:'购买生活商品，确认并验证后从本人储蓄卡即时扣款，生成持久订单。需商品ID、数量、收件人/手机号/地址、立即送出或预约送达。不要推断地址或时间；可用于生日送礼等跨场景DAG。仅模拟物流，不承诺真实发货。',inputSchema:purchase,
  prepare:async(a,ctx)=>{const p=lifeProduct(a.productId,'goods'),card=await source(ctx.userId,a),dates=deliveryDates(a.delivery,await simNow());return {...a,cardId:card.id,fromAccountId:card.accountId,cardName:cardLabel(card),amountCents:Math.round(p.price*100)*a.quantity,deliveryAt:dates.deliveryAt.toISOString(),dispatchAt:dates.dispatchAt.toISOString()}},
  summarize:async args=>{const a=args as Purchase;return {title:'确认购买生活商品',fields:[{label:'商品',value:`${lifeProduct(a.productId).name} × ${a.quantity}`},{label:'金额',value:`¥${(a.amountCents/100).toFixed(2)}`},{label:'付款卡',value:a.cardName},{label:'收件人',value:`${a.delivery.recipient} ${a.delivery.phone}`},{label:'收货地址',value:a.delivery.address},{label:'配送',value:`${a.delivery.mode==='immediate'?'立即送出':'预约送达'} · 预计${lifeTime(a.deliveryAt)}`},{label:'退款规则',value:'未发货可原路退款；发货后至签收后7天可退货，模拟验收24小时'}] }},
  execute:async(a,ctx)=>buyLifeProduct(ctx,a as Purchase,await simNow()),
})
export const queryLifeOrders=defineBankTool({name:'list_life_orders',kind:'read',baseRisk:'green',description:'查询本人生活商城订单、付款状态、预计发货/送达时间、模拟物流、退货期限和退款进度；orderId可查单个订单。不得将模拟物流说成真实承运商。',inputSchema:z.object({orderId:z.string().optional()}),execute:async(a,ctx)=>({orders:await listLifeOrders(ctx.userId,await simNow(),a.orderId)})})
export const refundLifeOrder=defineBankTool({name:'return_life_order',kind:'write',baseRisk:'yellow',description:'申请本人订单退货退款。未发货即时原路退款；发货后至签收后7天内，24小时模拟退货验收后退款，重复申请不重复退款。超期转人工，不得承诺退款成功。',inputSchema:z.object({orderId:z.string(),reason:z.string().trim().min(1).max(200)}),
  summarize:async(a,ctx)=>{const [order]=await listLifeOrders(ctx.userId,await simNow(),a.orderId);if(!order)throw new Error('订单不存在');if(!order.canRefund)throw new Error('订单已退款、已申请退货或超过7天退货期');return {title:'确认退货退款',fields:[{label:'订单',value:order.id},{label:'商品',value:order.productName},{label:'退款金额',value:`¥${order.amount.toFixed(2)}`},{label:'退款账户',value:`原付款卡尾号${order.cardLast4}`},{label:'原因',value:a.reason},{label:'处理',value:order.status==='paid'?'未发货，确认后原路退款':'发货后退货，预计24小时模拟验收后原路退款'}]}},execute:async(a,ctx)=>returnLifeOrder(ctx,a.orderId,a.reason,await simNow()),
})
export const startLifeSubscription=defineBankTool({name:'subscribe_life_service',kind:'write',baseRisk:'yellow',description:'开通生活商城订阅并立即从本人储蓄卡扣首期费用。autoRenew默认为false；仅用户明确要求自动续费时设为true并确认次数，月费最多11次、年费最多1次，最长366天。服务为文财沙箱权益。已有有效期不能重复订阅。',inputSchema:subscription,
  prepare:async(a,ctx)=>{const p=lifeProduct(a.productId,'subscription'),card=await source(ctx.userId,a);if(a.autoRenew&&p.cycle==='年'&&a.renewals>1)throw new Error('年费订阅最多授权1次续费');return {...a,renewals:a.autoRenew?a.renewals:0,cardId:card.id,fromAccountId:card.accountId,cardName:cardLabel(card),amountCents:Math.round(p.price*100)}},
  summarize:async args=>{const a=args as Subscription,p=lifeProduct(a.productId);return {title:'确认开通订阅',fields:[{label:'服务',value:p.name},{label:'金额',value:`¥${p.price.toFixed(2)} / ${p.cycle}`},{label:'付款卡',value:a.cardName},{label:'扣款',value:'确认后立即扣首期费用'},{label:'续费授权',value:a.autoRenew?`最多${a.renewals}次，每次¥${p.price.toFixed(2)}，首期及续费累计不超过¥${(p.price*(a.renewals+1)).toFixed(2)}，最长366天`:'仅开通一期，不自动续费'},{label:'取消',value:'取消后停止后续扣款，已付费期间保留服务，不退当期费用'}]}},
  execute:async(a,ctx)=>subscribeLifeService(ctx,a as Subscription,await simNow()),
})
export const queryLifeSubscriptions=defineBankTool({name:'list_life_subscriptions',kind:'read',baseRisk:'green',description:'查询本人订阅开通/取消状态、服务有效期、付款卡、下次扣费和剩余续费次数，含生活商城与已有订阅。取消用cancel_subscription。',inputSchema:z.object({}),execute:async(_a,ctx)=>({subscriptions:await listLifeSubscriptions(ctx.userId,await simNow())})})
export const LIFE_TOOLS=[listLifeCatalog,purchaseLifeProduct,queryLifeOrders,refundLifeOrder,startLifeSubscription,queryLifeSubscriptions]
