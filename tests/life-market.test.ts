import { describe, expect, it } from 'vitest'
import { demoOrderKey, filterLifeProducts, LIFE_PRODUCTS, parseDemoOrders } from '#/lib/life-market'
describe('生活商城演示目录',()=>{
  it('商城和订阅分别展示且可搜索、清空搜索',()=>{
    expect(filterLifeProducts('goods','')).toHaveLength(4)
    expect(filterLifeProducts('subscription','')).toHaveLength(4)
    expect(filterLifeProducts('goods','  保温  ').map(p=>p.id)).toEqual(['cup'])
    expect(filterLifeProducts('subscription','音乐').map(p=>p.id)).toEqual(['music'])
    expect(filterLifeProducts('goods','音乐')).toEqual([])
  })
  it('演示订单仅接受商品，不能把目录服务误开通成订阅',()=>{
    const order=(productId:string)=>({id:productId,productId,createdAt:'2026-10-15T08:00:00Z'})
    expect(parseDemoOrders(JSON.stringify([order('cup'),order('video'),order('unknown'),{...order('gift'),createdAt:'invalid'}])).map(o=>o.productId)).toEqual(['cup'])
    expect(parseDemoOrders('bad-json')).toEqual([])
    expect(parseDemoOrders('{}')).toEqual([])
    expect(LIFE_PRODUCTS.every(item=>item.price>0)).toBe(true)
  })
  it('订单按登录用户隔离并限制历史数量',()=>{
    expect(demoOrderKey('A/B')).not.toBe(demoOrderKey('A%2FB'))
    expect(demoOrderKey('alice')).not.toBe(demoOrderKey('bob'))
    expect(parseDemoOrders(JSON.stringify(Array.from({length:60},(_,i)=>({id:String(i),productId:'cup',createdAt:'2026-10-15T08:00:00Z'}))))).toHaveLength(50)
  })
})
