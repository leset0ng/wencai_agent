import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { inArray } from 'drizzle-orm'
import { db, schema } from '#/server/db/client'
import { businessDate } from '#/lib/dashboard'
import { listTransactions, TransactionQuerySchema } from '#/server/tools/transaction-query'
import { getDashboard } from '#/server/dashboard'

vi.mock('#/server/tools/jobs',()=>({simNow:async()=>new Date('2026-10-15T00:00:00Z')}))
const owner='u_date_query', other='u_date_other', empty='u_date_empty'
const ids=['date_account_a','date_account_b','date_account_other']
const ctx={userId:owner,sessionId:'date-query-tests',channel:'web' as const}
const query=(input:unknown)=>listTransactions.execute(TransactionQuerySchema.parse(input),ctx)
beforeAll(async()=>{
  await db.insert(schema.users).values([owner,other,empty].map(id=>({id,name:id})))
  await db.insert(schema.accounts).values(ids.map((id,i)=>({id,userId:i===2?other:owner,name:`日期账户${i}`,balanceCents:100_000})))
  await db.insert(schema.cards).values(ids.map((accountId,i)=>({id:`date_card_${i}`,userId:i===2?other:owner,accountId,kind:'debit' as const,status:'active' as const,last4:['1111','2222','9999'][i],dailyLimitCents:100_000})))
  const tx=(id:string,accountId:string,time:string,amountCents:number,category='转账')=>({id,accountId,occurredAt:new Date(time),amountCents,category,counterparty:id})
  await db.insert(schema.transactions).values([
    tx('date_before',ids[0],'2026-09-06T15:59:59.999Z',-999),
    tx('date_start',ids[0],'2026-09-06T16:00:00Z',-20000),
    tx('date_shopping',ids[0],'2026-09-07T15:59:59.999Z',-1922,'购物'),
    tx('date_end',ids[1],'2026-09-07T16:00:00Z',-8165),
    tx('date_other',ids[2],'2026-09-07T00:00:00Z',-777),
    ...Array.from({length:55},(_,i)=>tx(`date_noise_${i}`,ids[0],`2026-10-14T00:${String(i).padStart(2,'0')}:00Z`,-100-i,'餐饮')),
  ])
})
afterAll(async()=>{
  await db.delete(schema.transactions).where(inArray(schema.transactions.accountId,ids))
  for (const table of [schema.bankCardProfiles,schema.bankCardNumbers,schema.bankCardPasswords]) {
    await db.delete(table).where(inArray(table.cardId,['date_card_0','date_card_1','date_card_2']))
  }
  await db.delete(schema.cards).where(inArray(schema.cards.userId,[owner,other]))
  await db.delete(schema.accounts).where(inArray(schema.accounts.id,ids))
  await db.delete(schema.users).where(inArray(schema.users.id,[owner,other,empty]))
})

describe('按北京时间查询完整账单',()=>{
  it('先在数据库筛选指定日期再分页，包含零点、排除次日零点，隔离其他用户',async()=>{
    const result=await query({date:'2026-09-07',limit:20})
    expect(result.matchedCount).toBe(2)
    expect(result.hasMore).toBe(false)
    expect(result.transactions.map(t=>t.id)).toEqual(['date_shopping','date_start'])
    expect(result.transactions.every(t=>t.date==='2026-09-07')).toBe(true)
    expect(result.transactions[1].time).toBe('2026-09-07 00:00:00')
  })
  it('只有明确转账查询才筛选分类，购物账单和空转账结果不会混为一谈',async()=>{
    expect((await query({date:'2026-09-07',category:'购物'})).transactions.map(t=>t.id)).toEqual(['date_shopping'])
    expect((await query({date:'2026-09-07',category:'转账'})).transactions.map(t=>t.id)).toEqual(['date_start'])
    const none=await query({date:'2026-09-09',category:'转账'})
    expect(none).toMatchObject({matchedCount:0,returnedCount:0,hasMore:false,transactions:[],query:{startDate:'2026-09-09',endDate:'2026-09-09',category:'转账'}})
  })
  it('本地日期和卡片归属与账户页面逐笔一致，不把 UTC 日期当成本地日期',async()=>{
    const result=await query({date:'2026-09-08',cardId:'date_card_1'})
    expect(result.transactions[0]).toMatchObject({id:'date_end',date:'2026-09-08',time:'2026-09-08 00:00:00',cardLast4:'2222',accountId:ids[1],cardId:'date_card_1'})
    const dashboard=await getDashboard(owner)
    const row=dashboard.accountActivity[ids[1]].transactions.find(t=>t.id==='date_end')!
    expect(businessDate(new Date(row.occurredAt))).toBe(result.transactions[0].date)
    expect(dashboard.cards.find(c=>c.accountId===row.accountId)?.last4).toBe(result.transactions[0].cardLast4)
  })
  it('日期范围包含两端，分页明确表示尚有记录，不假称查询完整',async()=>{
    const result=await query({startDate:'2026-09-07',endDate:'2026-09-08',limit:1})
    expect(result).toMatchObject({matchedCount:3,returnedCount:1,hasMore:true})
    const second=await query({startDate:'2026-09-07',endDate:'2026-09-08',limit:2,offset:1})
    expect(second.transactions.map(t=>t.id)).toEqual(['date_shopping','date_start'])
    expect(second.hasMore).toBe(false)
    expect((await query({days:90})).hasMore).toBe(true)
  })
  it('不能跨用户查账户或卡片，不能把另一张卡映射到指定账户',async()=>{
    await expect(query({date:'2026-09-07',accountId:ids[2]})).rejects.toThrow('不属于你')
    await expect(query({date:'2026-09-07',cardId:'date_card_2'})).rejects.toThrow('不属于你')
    await expect(query({date:'2026-09-07',cardId:'date_card_1',accountId:ids[0]})).rejects.toThrow('不匹配')
    const result=await listTransactions.execute(TransactionQuerySchema.parse({date:'2026-09-07'}),{...ctx,userId:empty})
    expect(result).toMatchObject({matchedCount:0,transactions:[]})
  })
  it('拒绝无效日期和冲突范围，避免日期自动进位查错天',()=>{
    for(const input of [{date:'2026-02-30'},{date:'2026-09-07',startDate:'2026-09-07',endDate:'2026-09-08'},{startDate:'2026-09-07'},{startDate:'2026-09-08',endDate:'2026-09-07'}]) expect(TransactionQuerySchema.safeParse(input).success).toBe(false)
  })
})
