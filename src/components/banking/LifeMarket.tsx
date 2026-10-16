import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarCheck2, Gift, ListChecks, Search, ShoppingBag, UsersRound } from 'lucide-react'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '#/components/ui/tabs'
import { Sheet } from '#/components/ui/Sheet'
import { Reveal } from '#/components/ui/motion'
import { formatAmount, type DashboardData } from '#/lib/dashboard'
import { filterLifeProducts, LIFE_PRODUCTS } from '#/lib/life-market'
import type { LifeCommerceData } from '#/lib/life-commerce'
import type { ToolOutcome } from '#/server/tools/define'
import { PaymentApproval } from './PaymentCenter'
import { LifeProductArt } from './LifeProductArt'
import { LifeCheckout, LifeOrders, LifeSubscriptions } from './LifeCommercePanels'
import './life-market.css'
type View={kind:'product';id:string}|{kind:'orders'|'subscriptions'}|null
type Pending=Extract<ToolOutcome,{status:'needs_confirmation'}>
export function LifeMarket({data,userId,hidden,active,portalContainer,onModalChange,onAgent,onTasks}:{data:DashboardData;userId:string;hidden:boolean;active:boolean;portalContainer:HTMLElement|null;onModalChange:(open:boolean)=>void;onAgent:(text:string)=>void;onTasks:()=>void}) {
  const [tab,setTab]=useState<'goods'|'subscription'>('goods'),[search,setSearch]=useState(''),[view,setView]=useState<View>(null)
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[pending,setPending]=useState<Pending>()
  const generation=useRef(0),qc=useQueryClient()
  const query=useQuery({queryKey:['life-commerce',userId],queryFn:async()=>{const res=await fetch('/api/payments?view=life',{credentials:'same-origin'});const body=await res.json();if(!res.ok)throw new Error(body.error??'暂时无法读取订单和订阅');return body as LifeCommerceData},enabled:active,retry:false,refetchInterval:active&&!!view?15000:false})
  useEffect(()=>()=>{generation.current++;onModalChange(false)},[onModalChange,userId])
  useEffect(()=>{if(!active){generation.current++;setView(null);setPending(undefined);setBusy(false);onModalChange(false)}},[active,onModalChange])
  const show=(next:View)=>{generation.current++;setView(next);setPending(undefined);setBusy(false);setError('');setNotice('');onModalChange(!!next)}
  const ask=(text:string)=>{show(null);onAgent(text)}
  const product=view?.kind==='product'?LIFE_PRODUCTS.find(p=>p.id===view.id):undefined,products=filterLifeProducts(tab,search)
  const activeSubs=query.data?.subscriptions.filter(s=>s.serviceStatus?s.serviceStatus==='active':s.status==='active')??[]
  const prepare=async(tool:string,args:unknown)=>{
    if(busy)return;const token=++generation.current;setBusy(true);setError('');setNotice('')
    try{const res=await fetch('/api/payments',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({tool,args})});const result=await res.json();if(!res.ok||result.status!=='needs_confirmation')throw new Error(result.error??result.message??result.reasons?.join('；')??'无法准备确认单');if(token===generation.current)setPending(result)}
    catch(e){if(token===generation.current)setError(e instanceof Error?e.message:'操作失败，请重试')}finally{if(token===generation.current)setBusy(false)}
  }
  return <div className="bank-life-market">
    <div className="bank-life-heading"><div><h1>生活商城</h1><p>订阅常用服务，选购生活好物</p></div><div className="bank-life-toolbar"><label className="bank-life-search"><Search size={21}/><Input aria-label={tab==='goods'?'搜索生活商品':'搜索订阅服务'} value={search} onChange={e=>setSearch(e.target.value)} placeholder={tab==='goods'?'搜索生活商品':'搜索订阅服务'}/></label><Button className="bank-life-secondary" onClick={()=>show({kind:tab==='goods'?'orders':'subscriptions'})}><ListChecks size={21}/>{tab==='goods'?'我的订单':'我的订阅'}</Button></div></div>
    <Tabs value={tab} onValueChange={value=>{setTab(value as typeof tab);setSearch('')}}>
      <TabsList className="bank-life-tabs" aria-label="生活商城分类"><TabsTrigger className="bank-life-tab" value="goods"><ShoppingBag size={23}/>商城</TabsTrigger><TabsTrigger className="bank-life-tab" value="subscription"><CalendarCheck2 size={23}/>订阅</TabsTrigger></TabsList>
      {(['goods','subscription'] as const).map(kind=><TabsContent key={kind} value={kind}><div className="bank-life-section-heading"><h2>{kind==='goods'?'生活好物':'订阅服务'}</h2><span>{products.length} {kind==='goods'?'件商品':'项服务'}</span>{kind==='subscription'&&<Button className="bank-life-link" onClick={()=>show({kind:'subscriptions'})}>管理现有订阅</Button>}</div><div className="bank-life-products">{products.map((item,index)=><Reveal key={item.id} delay={index*55}><article className="bank-life-product"><LifeProductArt product={item}/><div className="bank-life-product-copy"><span className="bank-life-demo-tag">文财生活</span><h3>{item.name}</h3><p>{item.description}</p><strong className="bank-life-price">¥{formatAmount(item.price)}{item.cycle&&<small> / {item.cycle}</small>}</strong><Button className="bank-life-primary" onClick={()=>show({kind:'product',id:item.id})}>{kind==='goods'?'查看商品':'查看服务'}</Button></div></article></Reveal>)}</div>{!products.length&&<div className="bank-life-empty"><Search size={28}/><p>没有找到对应{kind==='goods'?'商品':'服务'}</p><Button className="bank-life-link" onClick={()=>setSearch('')}>清空搜索</Button></div>}</TabsContent>)}
    </Tabs>
    <div className="bank-life-shortcuts"><Button onClick={()=>ask('帮我查询联系人生日和生活商城商品，为生日礼物安排预约送达，先向我询问预算、收件地址与付款卡。')}><Gift size={19}/>生日送礼</Button><Button onClick={()=>ask('我想发起一笔AA收款，请先帮我查看联系人')}><UsersRound size={19}/>AA 收款</Button><Button onClick={onTasks}><ListChecks size={19}/>任务中心</Button><Button onClick={()=>show({kind:'subscriptions'})}><CalendarCheck2 size={19}/>订阅管理<span>{activeSubs.length} 项生效中</span></Button></div>
    <p className="bank-life-disclaimer">文财模拟银行：购买、订阅与退款实际记入本系统账户；商品配送和会员权益使用模拟服务。</p>
    <Sheet open={!!view} onClose={()=>show(null)} title={view?.kind==='orders'?'我的订单':view?.kind==='subscriptions'?'订阅与代扣管理':product?.name??'商品详情'} className="bank-life-sheet" portalContainer={portalContainer}><div className="bank-life-dialog-content">
      {pending?<PaymentApproval pending={pending} onBack={()=>setPending(undefined)} onComplete={output=>{
        const result=output as Record<string,unknown>;setPending(undefined);setError('')
        if(result.orderId){setView({kind:'orders'});setNotice(result.status==='return_requested'?'退货已受理，预计24小时模拟验收后退款。':result.status==='refunded'?'退款已原路到账。':'购买成功，已扣款，请查看订单和预计送达时间。')}
        else{setView({kind:'subscriptions'});setNotice(result.status==='cancelled'?'已停止后续扣费，已付费服务保留至有效期结束。':'订阅已开通，首期费用已扣款。')}
        void qc.invalidateQueries({queryKey:['life-commerce',userId]});void qc.invalidateQueries({queryKey:['dashboard',userId]})
      }}/>:<>
        {product&&<><div className="bank-life-detail-art"><LifeProductArt product={product}/></div><h2>{product.name}</h2><strong className="bank-life-price">¥{formatAmount(product.price)}{product.cycle&&<small> / {product.cycle}</small>}</strong><p className="bank-life-detail-description">{product.detail}</p><LifeCheckout key={product.id} product={product} data={data} busy={busy} onPrepare={(tool,args)=>void prepare(tool,args)} onAgent={ask}/></>}
        {notice&&<p className="bank-life-notice" role="status">{notice}</p>}
        {view?.kind!=='product'&&query.isPending&&<p className="bank-life-notice" role="status">正在读取订单和订阅…</p>}
        {view?.kind!=='product'&&query.error&&<div role="alert"><p className="bank-error">{query.error.message}</p><Button className="bank-life-link" onClick={()=>void query.refetch()}>重新加载</Button></div>}
        {view?.kind==='orders'&&query.data&&<LifeOrders orders={query.data.orders} busy={busy} hidden={hidden} onPrepare={(tool,args)=>void prepare(tool,args)} onAgent={ask}/>}
        {view?.kind==='subscriptions'&&query.data&&<LifeSubscriptions items={query.data.subscriptions} busy={busy} hidden={hidden} onPrepare={(tool,args)=>void prepare(tool,args)} onAgent={ask}/>}
      </>}{error&&<p className="bank-error" role="alert">{error}</p>}
    </div></Sheet>
  </div>
}
