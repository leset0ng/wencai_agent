export type LifeProduct = { id:string; name:string; description:string; price:number; kind:'goods'|'subscription'; art:'cup'|'umbrella'|'organizer'|'gift'|'video'|'music'|'cloud'|'book'; cycle?:'月'|'年'; detail:string }
export const LIFE_PRODUCTS: LifeProduct[] = [
  {id:'cup',name:'简约保温杯',description:'随身饮水好搭档',price:59,kind:'goods',art:'cup',detail:'轻巧随行，简约配色。此商品用于展示商城浏览与演示订单流程。'},
  {id:'umbrella',name:'轻便折叠伞',description:'晴雨出行随身带',price:39,kind:'goods',art:'umbrella',detail:'便携折叠设计，适合日常通勤。尺寸、材质和库存均为演示设定。'},
  {id:'organizer',name:'桌面收纳盒',description:'整理桌面小物',price:29,kind:'goods',art:'organizer',detail:'分区收纳文具与随手小物，为桌面留出更多空间。仅用于商城演示。'},
  {id:'gift',name:'生活礼品卡',description:'送给在意的人',price:100,kind:'goods',art:'gift',detail:'一份心意，更多选择。演示礼品卡不具有储值、支付或兑换功能。'},
  {id:'video',name:'影音会员月卡',description:'畅享影视内容',price:25,kind:'subscription',art:'video',cycle:'月',detail:'影音服务展示方案，供比较周期和价格。未对接真实平台，不会开通会员或自动扣费。'},
  {id:'music',name:'音乐会员月卡',description:'聆听喜欢的音乐',price:15,kind:'subscription',art:'music',cycle:'月',detail:'音乐服务展示方案。可在“我的订阅”管理账户里已有的订阅与模拟代扣。'},
  {id:'cloud',name:'云盘扩容年卡',description:'存储重要文件',price:298,kind:'subscription',art:'cloud',cycle:'年',detail:'云存储服务展示方案，未接入真实云盘，商品展示不代表已签约。'},
  {id:'book',name:'阅读会员月卡',description:'发现更多好书',price:19,kind:'subscription',art:'book',cycle:'月',detail:'阅读服务展示方案。价格和服务内容为测试数据，暂不支持实际开通。'},
]
export function filterLifeProducts(kind:LifeProduct['kind'], search:string) {
  const query=search.normalize('NFKC').trim().toLocaleLowerCase()
  return LIFE_PRODUCTS.filter(item=>item.kind===kind && `${item.name} ${item.description}`.toLocaleLowerCase().includes(query))
}
export type DemoLifeOrder = { id:string; productId:string; createdAt:string }
export const demoOrderKey=(userId:string)=>`wencai.life.demo-orders.v1:${encodeURIComponent(userId)}`
export function parseDemoOrders(raw:string|null):DemoLifeOrder[] {
  try {
    const data:unknown=JSON.parse(raw??'[]')
    if(!Array.isArray(data)) return []
    return data.filter((item):item is DemoLifeOrder=>!!item && typeof item==='object' && typeof item.id==='string' && typeof item.productId==='string' && LIFE_PRODUCTS.some(p=>p.id===item.productId && p.kind==='goods') && typeof item.createdAt==='string' && Number.isFinite(Date.parse(item.createdAt))).slice(0,50)
  } catch {return []}
}
