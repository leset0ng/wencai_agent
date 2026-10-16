import { useState } from 'react'
import { CalendarCheck2, PackageOpen, Sparkles } from 'lucide-react'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { SelectControl, SelectOption } from '#/components/ui/select'
import { formatAmount, type DashboardData } from '#/lib/dashboard'
import { LIFE_ORDER_STATUS, lifeTime, type LifeOrder, type LifeSubscription } from '#/lib/life-commerce'
import { LIFE_PRODUCTS, type LifeProduct } from '#/lib/life-market'
import { LifeProductArt } from './LifeProductArt'

export function LifeCheckout({product,data,busy,onPrepare,onAgent}:{product:LifeProduct;data:DashboardData;busy:boolean;onPrepare:(tool:string,args:unknown)=>void;onAgent:(text:string)=>void}) {
  const cards=data.cards.filter(c=>c.kind==='debit'&&c.status==='active')
  const [cardId,setCardId]=useState(cards[0]?.id??''),[quantity,setQuantity]=useState('1'),[recipient,setRecipient]=useState(''),[phone,setPhone]=useState(''),[address,setAddress]=useState(''),[mode,setMode]=useState('immediate'),[arriveAt,setArriveAt]=useState(''),[autoRenew,setAutoRenew]=useState(false),[renewals,setRenewals]=useState(product.cycle==='年'?'1':'3')
  const service=product.kind==='subscription'
  return <form className="bank-life-checkout" onSubmit={e=>{e.preventDefault();onPrepare(service?'subscribe_life_service':'buy_life_product',service?{productId:product.id,cardId,autoRenew,renewals:Number(renewals)}:{productId:product.id,cardId,quantity:Number(quantity),delivery:{recipient,phone,address,mode,...(mode==='scheduled'?{arriveAt:`${arriveAt.length===16?`${arriveAt}:00`:arriveAt}+08:00`}:{})}})}}>
    <label>付款储蓄卡<SelectControl value={cardId} onValueChange={setCardId} disabled={busy} required>{cards.map(c=><SelectOption key={c.id} value={c.id}>{c.remark||c.accountName} · 尾号{c.last4}</SelectOption>)}</SelectControl></label>
    {!cards.length&&<p className="bank-life-notice">请先申请并存入资金到储蓄卡，再办理购买或订阅。</p>}
    {service?<><label className="bank-life-renew"><input type="checkbox" checked={autoRenew} disabled={busy} onChange={e=>setAutoRenew(e.target.checked)}/>授权自动续费</label>{autoRenew&&<label>最多续费次数<Input type="number" min={1} max={product.cycle==='年'?1:11} required value={renewals} disabled={busy} onChange={e=>setRenewals(e.target.value)}/></label>}<p className="bank-life-detail-description">{autoRenew?`每次 ¥${formatAmount(product.price)}，首期及续费累计上限 ¥${formatAmount(product.price*(Number(renewals)+1))}，授权最长366天，可随时取消后续扣费。`:'仅开通一期，到期不自动扣费。'}取消后已付费服务保留至有效期结束，不退当期费用。</p></>:<>
      <label>购买数量<Input type="number" required min={1} max={20} value={quantity} disabled={busy} onChange={e=>setQuantity(e.target.value)}/></label>
      <div className="bank-life-checkout-pair"><label>收件人<Input required maxLength={50} value={recipient} disabled={busy} onChange={e=>setRecipient(e.target.value)}/></label><label>手机号<Input required type="tel" pattern="1[0-9]{10}" maxLength={11} value={phone} disabled={busy} onChange={e=>setPhone(e.target.value)}/></label></div>
      <label>收货地址<Input required minLength={5} maxLength={200} value={address} disabled={busy} onChange={e=>setAddress(e.target.value)} placeholder="城市、街道、门牌等完整地址"/></label>
      <label>配送方式<SelectControl value={mode} onValueChange={setMode} disabled={busy}><SelectOption value="immediate">立即送出 · 预计48小时送达</SelectOption><SelectOption value="scheduled">预约送达时间</SelectOption></SelectControl></label>
      {mode==='scheduled'&&<label>预约送达（北京时间）<Input required type="datetime-local" value={arriveAt} disabled={busy} onInput={e=>setArriveAt(e.currentTarget.value)} onChange={e=>setArriveAt(e.currentTarget.value)}/><small>至少48小时后、90天内；下单时即扣款。</small></label>}
      <p className="bank-life-detail-description">未发货可原路退款；发货后至模拟签收后7天内支持退货，预计24小时模拟验收后退款。</p>
    </>}
    <div className="bank-life-checkout-total"><span>{service?'本次首期付款':'本次付款'}</span><strong>¥{formatAmount(product.price*(service?1:Number(quantity)||0))}</strong></div>
    <Button type="submit" disabled={busy||!cardId} className="bank-life-primary">{busy?'正在准备…':service?'核对并订阅':'核对并购买'}</Button>
    <Button type="button" className="bank-life-link" disabled={busy} onClick={()=>onAgent(`请查询生活商城${service?'服务':'商品'}「${product.name}」（productId：${product.id}），协助我${service?'开通订阅':'购买并安排送达'}。先询问缺少的付款卡和必要参数，生成确认单后由我验证。`)}>让文财帮我办理</Button>
  </form>
}
export function LifeOrders({orders,busy,hidden,onPrepare,onAgent}:{orders:LifeOrder[];busy:boolean;hidden:boolean;onPrepare:(tool:string,args:unknown)=>void;onAgent:(text:string)=>void}) {
  const [returnId,setReturnId]=useState(''),[reason,setReason]=useState('不再需要')
  return <><p className="bank-life-disclaimer">最近100笔本人订单。付款与退款记入银行流水，配送使用文财模拟物流。</p>{orders.map(order=><article className="bank-life-purchased-order" key={order.id}>
    <div className="bank-life-order"><LifeProductArt product={LIFE_PRODUCTS.find(p=>p.id===order.productId)!}/><div><strong>{order.productName} × {order.quantity}</strong><p>{LIFE_ORDER_STATUS[order.status]} · {hidden?'••••••':`¥${formatAmount(order.amount)}`}</p><small>付款卡尾号 {order.cardLast4}</small></div></div>
    <dl><div><dt>订单号</dt><dd>{order.id}</dd></div><div><dt>购买时间</dt><dd>{lifeTime(order.createdAt)}</dd></div><div><dt>预计发货</dt><dd>{lifeTime(order.dispatchAt)}</dd></div><div><dt>预计送达</dt><dd>{lifeTime(order.deliveryAt)}</dd></div><div><dt>收件人</dt><dd>{order.delivery.recipient} · {order.delivery.phone}</dd></div><div><dt>地址</dt><dd>{order.delivery.address}</dd></div></dl>
    <p className="bank-life-logistics">{order.logistics}</p>{order.refundDueAt&&<p className="bank-life-logistics">预计退款：{lifeTime(order.refundDueAt)}</p>}{order.refundedAt&&<p className="bank-life-logistics">已退款：{lifeTime(order.refundedAt)}</p>}
    <div className="bank-life-order-actions"><Button className="bank-life-secondary" disabled={busy||!order.canRefund} onClick={()=>{setReturnId(order.id);setReason('不再需要')}}>{order.status==='refunded'?'已退款':order.status==='return_requested'?'退货处理中':order.canRefund?'申请退货退款':'已过退货期'}</Button><Button className="bank-life-link" onClick={()=>onAgent(`请查询我的生活订单 ${order.id}（${order.productName}）的购买状态、物流与退货退款条件。`)}>让文财查订单</Button></div>
    {returnId===order.id&&order.canRefund&&<form className="bank-life-return-form" onSubmit={e=>{e.preventDefault();onPrepare('return_life_order',{orderId:order.id,reason})}}><label>退款原因<Input value={reason} onChange={e=>setReason(e.target.value)} required maxLength={200} disabled={busy}/></label><small>退货申请须在 {lifeTime(order.refundDeadline)} 前提交。</small><Button className="bank-life-primary" type="submit" disabled={busy}>{busy?'准备中…':'核对退货退款'}</Button></form>}
  </article>)}{!orders.length&&<div className="bank-life-empty"><PackageOpen size={38}/><p>暂无购买订单</p></div>}</>
}
export function LifeSubscriptions({items,hidden,busy,onPrepare,onAgent}:{items:LifeSubscription[];hidden:boolean;busy:boolean;onPrepare:(tool:string,args:unknown)=>void;onAgent:(text:string)=>void}) {
  const [search,setSearch]=useState('')
  const active=items.filter(s=>s.serviceStatus?s.serviceStatus==='active':s.status==='active')
  return <><div className="bank-life-sub-summary"><div><small>生效中</small><strong>{active.length} 项</strong></div><div><small>月费合计</small><strong>{hidden?'••••••':`¥${formatAmount(active.filter(s=>s.cycle==='monthly').reduce((n,s)=>n+s.amount,0))}`}</strong></div><div><small>年费合计</small><strong>{hidden?'••••••':`¥${formatAmount(active.filter(s=>s.cycle==='yearly').reduce((n,s)=>n+s.amount,0))}`}</strong></div></div>
    <Input aria-label="搜索我的订阅" placeholder="搜索我的订阅" value={search} onChange={e=>setSearch(e.target.value)}/><Button className="bank-life-secondary bank-life-detect" onClick={()=>onAgent('请查询我的订阅状态、服务有效期和下次续费，并从银行流水识别尚未登记的周期扣费，区分已开通和候选。')}><Sparkles size={19}/>让文财查询订阅与续费提醒</Button>
    {items.filter(s=>s.merchant.includes(search.trim())).map(item=><article className="bank-life-subscription-row" key={item.id}><span className="bank-life-sub-icon"><CalendarCheck2 size={23}/></span><div><strong>{item.merchant}</strong><p>{item.cycle==='monthly'?'每月':'每年'} · {item.status==='cancelled'?'已取消续费':item.serviceStatus==='expired'?'已到期':'生效中'}</p><b>{hidden?'••••••':`¥${formatAmount(item.amount)}`}</b>{item.periodEnd&&<><p>服务有效至 {lifeTime(item.periodEnd)}{item.serviceStatus==='expired'?'（已到期）':''}</p><p>{item.nextChargeAt?`下次扣费 ${lifeTime(item.nextChargeAt)} · 剩余${item.renewalsLeft}次`:item.renewalStatus==='past_due'?'续费已暂停，请重新核对':'无后续自动扣费'} · 付款卡尾号{item.cardLast4}</p></>}</div><Button className="bank-life-secondary" disabled={busy||item.status!=='active'} onClick={()=>onPrepare('cancel_subscription',{subscriptionId:item.id})}>{item.status==='cancelled'?'已取消':busy?'准备中…':'取消订阅'}</Button></article>)}
    {!items.length&&<div className="bank-life-empty"><CalendarCheck2 size={32}/><p>暂无已登记订阅，可在服务详情中开通。</p></div>}<p className="bank-life-disclaimer">取消后不再自动扣款，已付费服务保留至有效期，不退当期费用。历史导入订阅的外部权益以原服务商为准。</p>
  </>
}
