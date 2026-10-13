import { z } from 'zod'
import { defineBankTool } from './define'
import { mySplitRequests, paySplitRequest } from '#/server/payments/splits'
import { cardLabel, resolveCard } from '#/server/cards/service'
export const listSplitRequests = defineBankTool({ name: 'list_split_requests', kind: 'read', baseRisk: 'green', description: '查询别人向本人发起的 AA 付款请求、金额与支付状态。', inputSchema: z.object({}), execute: (_a, ctx) => mySplitRequests(ctx.userId) })
const input = z.object({ requestId: z.string(), fromCardQuery: z.string().min(1) })
type Prepared = z.infer<typeof input> & { fromAccountId: string; amountCents: number }
export const paySplit = defineBankTool({
  factsHint: (a) => ({ splitRequestId: a.requestId }),
  name: 'pay_split_request', kind: 'write', baseRisk: 'red', description: '本人确认支付收到的 AA 请求，从指定储蓄卡扣款并实际入账发起人，同一请求只能支付一次。重名卡先询问尾号，必须强验证。', inputSchema: input,
  prepare: async (a, ctx) => { const request = (await mySplitRequests(ctx.userId)).find((r) => r.id === a.requestId && r.status === 'pending'); if (!request) throw new Error('AA请求不存在或已处理'); const card = await resolveCard(ctx.userId, a.fromCardQuery, 'debit'); return { ...a, fromAccountId: card.accountId, amountCents: request.amountCents } },
  summarize: async (a, ctx) => { const card = await resolveCard(ctx.userId, a.fromCardQuery, 'debit'); const request = (await mySplitRequests(ctx.userId)).find((r) => r.id === a.requestId); if (!request) throw new Error('请求不存在'); return { title: '确认 AA 付款', fields: [{ label: '付款卡', value: cardLabel(card) }, { label: '收款人', value: request.requesterName }, { label: '事由', value: request.title }, { label: '金额', value: `¥${((a as Prepared).amountCents / 100).toFixed(2)}` }] } },
  execute: (a, ctx) => paySplitRequest(ctx.userId, a.requestId, (a as Prepared).fromAccountId, ctx),
})
export const SPLIT_TOOLS = [listSplitRequests, paySplit]
