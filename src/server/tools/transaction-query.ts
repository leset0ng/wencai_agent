import { and, count, desc, eq, gte, inArray, lt, lte } from 'drizzle-orm'
import { z } from 'zod'
import { businessDate, businessDateTime } from '#/lib/dashboard'
import { db, schema } from '#/server/db/client'
import { cardKindName, userCards } from '#/server/cards/service'
import { simNow } from './jobs'
import { defineBankTool } from './define'

const DAY = 86_400_000
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((date) => {
  const parsed = new Date(`${date}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date
}, '请提供有效日期 YYYY-MM-DD')

export const TransactionQuerySchema = z.object({
  date: localDate.optional().describe('查询某一天的北京时间日期 YYYY-MM-DD；优先使用此参数，不要查最近N天再自行找日期'),
  startDate: localDate.optional().describe('北京时间起始日期（含）'),
  endDate: localDate.optional().describe('北京时间结束日期（含），须与startDate同时提供'),
  days: z.number().int().min(1).max(365).default(30),
  category: z.string().optional().describe('如餐饮、交通、购物、娱乐、生活缴费、转账；“账单/交易记录”不设置分类，只有明确查询转账时设为转账'),
  accountId: z.string().optional().describe('只查询此资金账户，必须属于当前用户'),
  cardId: z.string().optional().describe('只查询这张银行卡绑定账户，必须属于当前用户'),
  limit: z.number().int().min(1).max(50).default(20),
  offset: z.number().int().min(0).max(100_000).default(0),
}).refine((q) => !q.date || (!q.startDate && !q.endDate), '单日与日期范围不可混用')
  .refine((q) => !!q.startDate === !!q.endDate, '日期范围须同时提供startDate和endDate')
  .refine((q) => !q.startDate || !q.endDate || q.startDate <= q.endDate, '结束日期不能早于开始日期')

export const listTransactions = defineBankTool({
  name: 'list_transactions',
  description: '查询真实交易明细，支持指定北京时间日期/日期范围、分类和本人卡片。返回transactions、matchedCount和hasMore，每笔含本地日期时间及银行卡归属。先按日期筛选数据库再分页；hasMore时不能断言未返回记录不存在。没有转账不等于没有其他账单，不得擅自补充邻近日期的记录。',
  baseRisk: 'green', kind: 'read', inputSchema: TransactionQuerySchema,
  execute: async ({date, startDate, endDate, days, category, accountId, cardId, limit, offset}, ctx) => {
    // 与首页使用相同的独立卡片账户映射，兼容旧库的迁移。
    const cards = await userCards(ctx.userId)
    const accounts = await db.select().from(schema.accounts).where(eq(schema.accounts.userId, ctx.userId))
    const card = cardId ? cards.find((item) => item.id === cardId) : undefined
    if (cardId && !card) throw new Error('银行卡不存在或不属于你')
    if (accountId && !accounts.some((item) => item.id === accountId)) throw new Error('账户不存在或不属于你')
    if (card && accountId && card.accountId !== accountId) throw new Error('银行卡与查询账户不匹配')
    const scopedAccount = card?.accountId ?? accountId
    const now = await simNow()
    const fromDate = date ?? startDate
    const toDate = date ?? endDate
    const start = fromDate ? new Date(`${fromDate}T00:00:00+08:00`) : new Date(now.getTime() - days * DAY)
    const until = toDate ? new Date(new Date(`${toDate}T00:00:00+08:00`).getTime() + DAY) : now
    const result = {kind: 'transaction_history' as const, timeZone: 'Asia/Shanghai' as const,
      query: {startDate: fromDate ?? businessDate(start), endDate: toDate ?? businessDate(now), category: category ?? null, accountId: scopedAccount ?? null, cardId: cardId ?? null, limit, offset},
      matchedCount: 0, returnedCount: 0, hasMore: false, transactions: [] as TransactionRecord[]}
    if (!accounts.length) return result
    const where = and(inArray(schema.transactions.accountId, accounts.map((item) => item.id)),
      scopedAccount ? eq(schema.transactions.accountId, scopedAccount) : undefined,
      gte(schema.transactions.occurredAt,start), toDate ? lt(schema.transactions.occurredAt,until) : lte(schema.transactions.occurredAt,until),
      category ? eq(schema.transactions.category,category) : undefined)
    // 同一读事务中获取总量和当前页，避免并发新增交易造成分页统计与明细不一致。
    const {total,rows} = await db.transaction(async (tx) => {
      const [total] = await tx.select({value:count()}).from(schema.transactions).where(where)
      const rows = await tx.select().from(schema.transactions).where(where).orderBy(desc(schema.transactions.occurredAt),desc(schema.transactions.id)).limit(limit).offset(offset)
      return {total:total.value,rows}
    })
    result.transactions = rows.map((row) => {
      const linked = cards.find((item) => item.accountId === row.accountId)
      return {id:row.id, amount:row.amountCents/100, counterparty:row.counterparty, memo:row.memo, category:row.category,
        date:businessDate(row.occurredAt), time:businessDateTime(row.occurredAt), occurredAt:row.occurredAt.toISOString(),
        accountId:row.accountId, accountName:linked?.remark || (linked ? cardKindName(linked.kind) : accounts.find((item) => item.id === row.accountId)!.name),
        cardId:linked?.id ?? null, cardLast4:linked?.last4 ?? null, cardKind:linked?.kind ?? null}
    })
    return {...result,matchedCount:total,returnedCount:rows.length,hasMore:offset+rows.length < total}
  },
})

export type TransactionRecord = {id:string;amount:number;counterparty:string;memo:string|null;category:string;date:string;time:string;occurredAt:string;accountId:string;accountName:string;cardId:string|null;cardLast4:string|null;cardKind:string|null}
