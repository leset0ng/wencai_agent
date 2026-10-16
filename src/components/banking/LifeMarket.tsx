import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { CalendarCheck2, Gift, ListChecks, PackageOpen, Search, ShoppingBag, Sparkles, UsersRound } from 'lucide-react'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '#/components/ui/tabs'
import { Sheet } from '#/components/ui/Sheet'
import { Reveal } from '#/components/ui/motion'
import { formatAmount, type DashboardData } from '#/lib/dashboard'
import { demoOrderKey, filterLifeProducts, LIFE_PRODUCTS, parseDemoOrders, type DemoLifeOrder } from '#/lib/life-market'
import type { ToolOutcome } from '#/server/tools/define'
import { PaymentApproval } from './PaymentCenter'
import { LifeProductArt } from './LifeProductArt'
import './life-market.css'

type View={kind:'product';id:string}|{kind:'orders'|'subscriptions'}|null
type Pending=Extract<ToolOutcome,{status:'needs_confirmation'}>
export function LifeMarket({data,userId,hidden,active,portalContainer,onModalChange,onAgent,onTasks}:{data:DashboardData;userId:string;hidden:boolean;active:boolean;portalContainer:HTMLElement|null;onModalChange:(open:boolean)=>void;onAgent:(text:string)=>void;onTasks:()=>void}) {
  const [tab,setTab]=useState<'goods'|'subscription'>('goods'),[search,setSearch]=useState('')
  const [view,setView]=useState<View>(null),[orderState,setOrders]=useState<{owner:string;items:DemoLifeOrder[]}>({owner:userId,items:[]})
  const [subSearch,setSubSearch]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('')
  const [pending,setPending]=useState<Pending>()
  const qc=useQueryClient()
  const orders=orderState.owner===userId?orderState.items:[]
  useEffect(()=>{try{setOrders({owner:userId,items:parseDemoOrders(localStorage.getItem(demoOrderKey(userId)))})}catch{setOrders({owner:userId,items:[]})}},[userId])
  useEffect(()=>()=>onModalChange(false),[onModalChange])
  useEffect(()=>{if(!active){setView(null);onModalChange(false)}},[active,onModalChange])
  const show=(next:View)=>{setView(next);setPending(undefined);setError('');setNotice('');onModalChange(!!next)}
  const ask=(text:string)=>{show(null);onAgent(text)}
  const product=view?.kind==='product'?LIFE_PRODUCTS.find(p=>p.id===view.id):undefined
  const products=filterLifeProducts(tab,search)
  const subscriptions=data.subscriptions.filter(item=>item.merchant.includes(subSearch.trim()))
  const activeSubs=data.subscriptions.filter(item=>item.status==='active')
  const total=(cycle:string)=>hidden?'••••••':`¥ ${formatAmount(activeSubs.filter(s=>s.cycle===cycle).reduce((sum,s)=>sum+s.amount,0))}`
  const createOrder=()=>{
    if(!product||product.kind!=='goods')return
    const items=[{id:crypto.randomUUID(),productId:product.id,createdAt:new Date().toISOString()},...orders].slice(0,50)
    setOrders({owner:userId,items})
    let saved=true
    try{localStorage.setItem(demoOrderKey(userId),JSON.stringify(items))}catch{saved=false}
    setView({kind:'orders'});setNotice(saved?'演示订单已生成，未扣款，不安排发货。':'演示订单已生成，但浏览器无法保存；仅在当前页面保留。未扣款、不发货。')
  }
  const cancel=async(id:string)=>{
    if(busy)return
    setBusy(true);setError('');setNotice('')
    try{
      const res=await fetch('/api/payments',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({tool:'cancel_subscription',args:{subscriptionId:id}})})
      const result=await res.json()
      if(!res.ok||result.status!=='needs_confirmation')throw new Error(result.error??result.message??result.reasons?.join('；')??'暂时无法准备取消确认单')
      setPending(result)
    }catch(e){setError(e instanceof Error?e.message:'操作失败，请重试')}finally{setBusy(false)}
  }
  return <div className="bank-life-market">
    <div className="bank-life-heading"><div><h1>生活商城</h1><p>订阅常用服务，选购生活好物</p></div><div className="bank-life-toolbar"><label className="bank-life-search"><Search size={21}/><Input aria-label={tab==='goods'?'搜索生活商品':'搜索订阅服务'} value={search} onChange={e=>setSearch(e.target.value)} placeholder={tab==='goods'?'搜索生活商品':'搜索订阅服务'}/></label><Button className="bank-life-secondary" onClick={()=>show({kind:tab==='goods'?'orders':'subscriptions'})}><ListChecks size={21}/>{tab==='goods'?'我的订单':'我的订阅'}</Button></div></div>
    <Tabs value={tab} onValueChange={value=>{setTab(value as typeof tab);setSearch('')}}>
      <TabsList className="bank-life-tabs" aria-label="生活商城分类"><TabsTrigger className="bank-life-tab" value="goods"><ShoppingBag size={23}/>商城</TabsTrigger><TabsTrigger className="bank-life-tab" value="subscription"><CalendarCheck2 size={23}/>订阅</TabsTrigger></TabsList>
      {(['goods','subscription'] as const).map(kind=><TabsContent key={kind} value={kind}>
        <div className="bank-life-section-heading"><h2>{kind==='goods'?'生活好物':'订阅服务'}</h2><span>{products.length} {kind==='goods'?'件演示商品':'项演示服务'}</span>{kind==='subscription'&&<Button className="bank-life-link" onClick={()=>show({kind:'subscriptions'})}>管理现有订阅</Button>}</div>
        <div className="bank-life-products">{products.map((item,index)=><Reveal key={item.id} delay={index*55}><article className="bank-life-product"><LifeProductArt product={item}/><div className="bank-life-product-copy"><span className="bank-life-demo-tag">演示{kind==='goods'?'商品':'服务'}</span><h3>{item.name}</h3><p>{item.description}</p><strong className="bank-life-price">¥{formatAmount(item.price)}{item.cycle&&<small> / {item.cycle}</small>}</strong><Button className="bank-life-primary" onClick={()=>show({kind:'product',id:item.id})}>{kind==='goods'?'查看商品':'查看服务'}</Button></div></article></Reveal>)}</div>
        {!products.length&&<div className="bank-life-empty"><Search size={28}/><p>没有找到对应{kind==='goods'?'商品':'服务'}</p><Button className="bank-life-link" onClick={()=>setSearch('')}>清空搜索</Button></div>}
      </TabsContent>)}
    </Tabs>
    <div className="bank-life-shortcuts"><Button onClick={()=>ask('帮我查看生日计划和联系人')}><Gift size={19}/>生日计划</Button><Button onClick={()=>ask('我想发起一笔AA收款，请先帮我查看联系人')}><UsersRound size={19}/>AA 收款</Button><Button onClick={onTasks}><ListChecks size={19}/>任务中心</Button><Button onClick={()=>show({kind:'subscriptions'})}><CalendarCheck2 size={19}/>订阅管理<span>{activeSubs.length} 项生效中</span></Button></div>
    <p className="bank-life-disclaimer">商品与服务价格为演示数据，演示订单不会扣款或发货。</p>
    <Sheet open={!!view} onClose={()=>show(null)} title={view?.kind==='orders'?'我的演示订单':view?.kind==='subscriptions'?'订阅与代扣管理':product?.name??'商品详情'} className="bank-life-sheet" portalContainer={portalContainer}>
      <div className="bank-life-dialog-content">
        {product&&<><div className="bank-life-detail-art"><LifeProductArt product={product}/></div><span className="bank-life-demo-tag">演示{product.kind==='goods'?'商品':'服务'}</span><h2>{product.name}</h2><strong className="bank-life-price">¥{formatAmount(product.price)}{product.cycle&&<small> / {product.cycle}</small>}</strong><p className="bank-life-detail-description">{product.detail}</p><p className="bank-life-disclaimer">{product.kind==='goods'?'不会扣款或发货，仅生成当前设备上的演示订单。':'展示方案不会开通服务或新增自动扣费。'}</p><Button className="bank-life-primary" onClick={()=>product.kind==='goods'?createOrder():show({kind:'subscriptions'})}>{product.kind==='goods'?'生成演示订单':'管理我的订阅'}</Button></>}
        {view?.kind==='orders'&&<><p className="bank-life-disclaimer">订单仅保存在当前设备，按登录用户分别存储；均未付款，不发货。</p>{notice&&<p className="bank-life-notice" role="status">{notice}</p>}{orders.map(order=>{const item=LIFE_PRODUCTS.find(p=>p.id===order.productId)!;return <article className="bank-life-order" key={order.id}><LifeProductArt product={item}/><div><strong>{item.name}</strong><p>¥ {formatAmount(item.price)} · 演示 / 未付款</p><small>{new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'short'}).format(new Date(order.createdAt))}</small><Button className="bank-life-link" onClick={()=>show({kind:'product',id:item.id})}>查看商品</Button></div></article>})}{!orders.length&&<div className="bank-life-empty"><PackageOpen size={38}/><p>暂无演示订单</p><Button className="bank-life-link" onClick={()=>show(null)}>去逛逛</Button></div>}</>}
        {view?.kind==='subscriptions'&&(pending?<PaymentApproval pending={pending} onBack={()=>setPending(undefined)} onComplete={()=>{setPending(undefined);setNotice('银行已确认取消该订阅。');void qc.invalidateQueries({queryKey:['dashboard',userId]})}}/>:<><div className="bank-life-sub-summary"><div><small>生效中</small><strong>{activeSubs.length} 项</strong></div><div><small>月费合计</small><strong>{total('monthly')}</strong></div><div><small>年费合计</small><strong>{total('yearly')}</strong></div></div><label className="bank-life-search"><Search size={19}/><Input value={subSearch} onChange={e=>setSubSearch(e.target.value)} aria-label="搜索我的订阅" placeholder="搜索我的订阅"/></label><Button className="bank-life-secondary bank-life-detect" onClick={()=>ask('帮我从真实银行流水识别订阅和周期扣费，区分候选与已登记订阅，并查看续费提醒')}><Sparkles size={19}/>让文财识别订阅与续费提醒</Button>{notice&&<p className="bank-life-notice" role="status">{notice}</p>}{subscriptions.map(item=><article className="bank-life-subscription-row" key={item.id}><span className="bank-life-sub-icon"><CalendarCheck2 size={23}/></span><div><strong>{item.merchant}</strong><p>{item.cycle==='monthly'?'每月':'每年'} · {item.status==='active'?'生效中':item.status==='cancelled'?'已取消':'待核对'}</p><b>{hidden?'••••••':`¥ ${formatAmount(item.amount)}`}</b></div><Button className="bank-life-secondary" disabled={busy||item.status!=='active'} onClick={()=>void cancel(item.id)}>{item.status==='cancelled'?'已取消':busy?'准备中…':'取消订阅'}</Button></article>)}{!subscriptions.length&&<div className="bank-life-empty"><CalendarCheck2 size={32}/><p>{subSearch?'没有匹配的订阅':'暂无已登记订阅'}</p></div>}<p className="bank-life-disclaimer">这里只展示本人已登记订阅。取消需核对确认，不会因点击查看而改变扣费状态。</p></>)}
        {error&&<p className="bank-error" role="alert">{error}</p>}
      </div>
    </Sheet>
  </div>
}
