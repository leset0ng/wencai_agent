import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { db, schema } from '#/server/db/client'
import { defineBankTool } from './define'
import { simNow } from './jobs'
import { listFunds, fundDetails } from '#/server/funds/store'
import { fundMetrics } from '#/server/funds/metrics'
import { previewFundOrder, submitFundOrder, compensateFundOrder, fundPortfolio } from '#/server/funds/trading'
import { AdviceInput, getWealthAdvice } from '#/server/funds/advice'
import { MarketQuery, getWealthMarket, getFundAnalytics } from '#/server/funds/market'

const order = z.object({ code: z.string().regex(/^\d{6}$/), fromAccountId: z.string().min(1), amountCents: z.number().int().positive().max(100_000_000) })
export const FUND_TOOLS = [
  defineBankTool({ name: 'rank_funds', description: '只读查询人工白名单内基金/债券基金排行榜，可按day/week/month/3m/6m/1y/3y/5y/all周期和returnPct/sharpe/maxDrawdownPct/volatilityPct/annualizedReturnPct排序，支持机构/名称/风险/自选和assetClass/style风格筛选。非全市场排名，空值不参与排名；与理财页使用同一套统计。', baseRisk: 'green', kind: 'read', inputSchema: MarketQuery,
    execute: async (a, ctx) => getWealthMarket(ctx.userId, a, await simNow()) }),
  defineBankTool({ name: 'get_fund_metrics', description: '只读查询指定基金全部九个周期的详细涨跌幅、净值变动额、夏普率、最大回撤、年化波动、年化收益及卡玛率，含样本数、起止日期、数据来源和计算假设；数据不足返回null，禁止当作零或编造。', baseRisk: 'green', kind: 'read', inputSchema: z.object({ code: z.string().regex(/^\d{6}$/) }),
    execute: async ({ code }) => getFundAnalytics(code, await simNow()) }),
  defineBankTool({ name: 'list_funds', description: '只读查询基金白名单、公开净值日期、缓存来源、风险和申购状态。净值不是实时成交价；风险等级为人工演示配置。', baseRisk: 'green', kind: 'read', inputSchema: z.object({}),
    execute: async () => listFunds(await simNow()) }),
  defineBankTool({ name: 'get_fund_details', description: '只读查询某基金历史净值与代码计算的历史收益、波动和最大回撤。', baseRisk: 'green', kind: 'read', inputSchema: z.object({ code: z.string().regex(/^\d{6}$/) }),
    execute: async ({ code }) => { const detail = await fundDetails(code, await simNow()); return { ...detail, metrics: fundMetrics(detail.navs) } } }),
  defineBankTool({ name: 'get_fund_portfolio', description: '只读查询本人基金持仓、估值与订单。submitted表示已扣款待净值确认，confirmed才有份额。', baseRisk: 'green', kind: 'read', inputSchema: z.object({}),
    execute: async (_, ctx) => fundPortfolio(ctx.userId, await simNow()) }),
  defineBankTool({ name: 'preview_fund_order', description: '校验基金风险匹配、付款账户、起购额、最新净值日期，签发参数绑定的申购预览令牌。不会扣款。', baseRisk: 'green', kind: 'read', inputSchema: order,
    execute: async (a, ctx) => previewFundOrder(ctx, a, await simNow()) }),
  defineBankTool({ name: 'commit_fund_order', description: '提交基金未知价申购，必须使用preview_fund_order令牌及原始参数。红色操作，独立安全页强验证后扣款；等待第一个日期不早于交易日的公布净值确认份额；QDII公布可能更晚。', baseRisk: 'red', kind: 'write', inputSchema: order.extend({ confirmationToken: z.string() }),
    summarize: async (a, ctx) => {
      const fund = await fundDetails(a.code, await simNow())
      const [token] = await db.select().from(schema.confirmationTokens).where(and(eq(schema.confirmationTokens.id, a.confirmationToken), eq(schema.confirmationTokens.userId, ctx.userId)))
      const plain = { code: a.code, fromAccountId: a.fromAccountId, amountCents: a.amountCents }
      if (!token || token.operation !== 'fund_purchase' || token.consumedAt || new Date(token.expiresAt) <= new Date() || token.paramHash !== JSON.stringify(plain)) throw new Error('基金预览无效，请重新预览')
      if (JSON.parse(token.summaryJson).purchaseFeeBp !== fund.purchaseFeeBp) throw new Error('基金费率已变化，请重新预览')
      const [account] = await db.select().from(schema.accounts).where(and(eq(schema.accounts.id, a.fromAccountId), eq(schema.accounts.userId, ctx.userId)))
      if (!account) throw new Error('付款账户不存在或不属于当前用户')
      const [card] = await db.select().from(schema.cards).where(and(eq(schema.cards.accountId, a.fromAccountId), eq(schema.cards.userId, ctx.userId)))
      return { title: '确认基金申购', fields: [{ label: '基金', value: `${fund.name}（${a.code}）` }, { label: '风险', value: fund.riskRating }, { label: '金额', value: `¥${(a.amountCents / 100).toFixed(2)}` }, { label: '申购费率', value: `${(fund.purchaseFeeBp / 100).toFixed(2)}%（外扣法）` }, { label: '付款账户', value: `${account.name}${card ? ` · 尾号${card.last4}` : ''}` }, { label: '计价方式', value: '未知价，扣款后净值公布后确认；以交易日及之后首个公布净值计算份额，QDII可能更晚' }] }
    },
    execute: async (a, ctx) => submitFundOrder(ctx, a, await simNow()),
    compensate: async (_, output, ctx) => compensateFundOrder(ctx, output.id, await simNow()),
  }),
  defineBankTool({ name: 'get_wealth_advice', description: '只读理财专家：代码复用#7画像月均支出、预留六个月生活费，计算可投金额、适当性过滤、指标、冲突与排序；模型仅看匿名候选并选至多3个写理由，数字/百分比不通过即代码回退。金额和目标收益只能来自当前用户原文；缺少期限或流动性先问选择题，缺少测评调用标准风险问卷。assetClasses和styles/avoidStyles按明确偏好选择；maxDrawdownPct须来自用户百分比。暂停或限额产品只列观察清单，不推荐为可申购。不会因无匹配而放宽条件。不创建确认单、不授权、不交易。', baseRisk: 'green', kind: 'read', inputSchema: AdviceInput,
    execute: async (a, ctx) => getWealthAdvice(ctx, a, await simNow()) }),
]
