export type LifeProduct = { id:string; name:string; description:string; price:number; kind:'goods'|'subscription'; art:'cup'|'umbrella'|'organizer'|'gift'|'video'|'music'|'cloud'|'book'; cycle?:'月'|'年'; detail:string }
export const LIFE_PRODUCTS: LifeProduct[] = [
  {id:'cup',name:'简约保温杯',description:'随身饮水好搭档',price:59,kind:'goods',art:'cup',detail:'轻巧随行，简约配色。支持购买、预约配送及符合期限的退货退款。'},
  {id:'umbrella',name:'轻便折叠伞',description:'晴雨出行随身带',price:39,kind:'goods',art:'umbrella',detail:'便携折叠设计，适合日常通勤。下单扣款并记录模拟物流，支持预约送达。'},
  {id:'organizer',name:'桌面收纳盒',description:'整理桌面小物',price:29,kind:'goods',art:'organizer',detail:'分区收纳文具与随手小物，为桌面留出更多空间。可购买并安排配送。'},
  {id:'gift',name:'生活礼品卡',description:'送给在意的人',price:100,kind:'goods',art:'gift',detail:'一份心意，更多选择。沙箱礼品卡可安排礼物配送，不具有真实储值或外部兑换功能。'},
  {id:'video',name:'影音会员月卡',description:'畅享影视内容',price:25,kind:'subscription',art:'video',cycle:'月',detail:'开通文财影音沙箱会员，首期立即扣费，有效期一个月；可选择有次数上限的自动续费。'},
  {id:'music',name:'音乐会员月卡',description:'聆听喜欢的音乐',price:15,kind:'subscription',art:'music',cycle:'月',detail:'开通文财音乐沙箱会员，按月计费，可查询有效期及取消后续扣费。'},
  {id:'cloud',name:'云盘扩容年卡',description:'存储重要文件',price:298,kind:'subscription',art:'cloud',cycle:'年',detail:'开通文财云盘沙箱年卡，首次扣费后有效一年；自动续费需单独授权。'},
  {id:'book',name:'阅读会员月卡',description:'发现更多好书',price:19,kind:'subscription',art:'book',cycle:'月',detail:'开通文财阅读沙箱会员，有效期一个月，支持本人或Agent发起订阅与取消。'},
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
