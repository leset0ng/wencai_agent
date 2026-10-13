import { z } from 'zod'
import { defineBankTool } from './define'
import { cardLabel, changeCreditLimit, createUserCard, findCards, ownProfile, repayCredit, resolveCard, saveCardRemark } from '#/server/cards/service'
import { reverseTransfer, settleTransfer, transferSummary } from '#/server/payments/service'

export const resolveMyCards = defineBankTool({
  name: 'resolve_my_cards', kind: 'read', baseRisk: 'green',
  description: '按银行卡备注、储蓄卡/信用卡类型或尾号查找本人的卡。needsDisambiguation=true 必须询问用户具体尾号，禁止默认第一张。工资卡是备注，不是卡类型。',
  inputSchema: z.object({ query: z.string().trim().min(1).max(100), kind: z.enum(['debit', 'credit']).optional() }),
  execute: async (a, ctx) => {
    const cards = await findCards(ctx.userId, a.query, a.kind)
    return { candidates: cards.map((c) => ({ cardId: c.id, accountId: c.accountId, kind: c.kind, last4: c.last4, remark: c.remark, status: c.status, balance: c.kind === 'debit' ? c.balanceCents / 100 : undefined, outstanding: c.kind === 'credit' ? c.outstandingCents / 100 : undefined })), needsDisambiguation: cards.length > 1 }
  },
})

const transferSchema = z.object({ fromCardQuery: z.string().trim().min(1).max(100), toCardQuery: z.string().trim().min(1).max(100), amountCents: z.number().int().positive().max(100_000_000), memo: z.string().max(50).optional() })
type CardTransfer = z.infer<typeof transferSchema> & { fromCardId: string; toCardId: string; fromAccountId: string; toAccountId: string }
export const transferBetweenCards = defineBankTool({
  name: 'transfer_between_cards', kind: 'write', baseRisk: 'yellow',
  description: '按备注或尾号在本人的储蓄卡间转账，例如工资卡转到储蓄卡A。金额单位分。重名会拒绝创建确认单并要求询问具体尾号。信用卡不能普通转账。',
  inputSchema: transferSchema,
  factsHint: (a) => ({ toAccountId: (a as CardTransfer).toAccountId }),
  prepare: async (a, ctx) => {
    const source = await resolveCard(ctx.userId, a.fromCardQuery, 'debit')
    const target = await resolveCard(ctx.userId, a.toCardQuery, 'debit')
    return { ...a, fromCardId: source.id, toCardId: target.id, fromAccountId: source.accountId, toAccountId: target.accountId }
  },
  summarize: async (input, ctx) => {
    const a = input as CardTransfer
    const [source, target] = await Promise.all([ownProfile(ctx.userId, a.fromCardId), ownProfile(ctx.userId, a.toCardId)])
    const summary = await transferSummary(a, ctx)
    return { ...summary, fields: [
      { label: '金额', value: `¥${(a.amountCents / 100).toFixed(2)}` },
      { label: '付款卡', value: cardLabel(source) }, { label: '收款卡', value: cardLabel(target) },
      ...(a.memo ? [{ label: '备注', value: a.memo }] : []),
    ] }
  },
  execute: async (input, ctx) => {
    const a = input as CardTransfer
    const [source, target] = await Promise.all([ownProfile(ctx.userId, a.fromCardId), ownProfile(ctx.userId, a.toCardId)])
    if (source.accountId !== a.fromAccountId || target.accountId !== a.toAccountId) throw new Error('卡片绑定已变更，请重新发起')
    return settleTransfer(a, ctx)
  },
  compensate: (_a, out, ctx) => reverseTransfer(out.transactionId, ctx),
})

export const setCardRemark = defineBankTool({
  name: 'set_card_remark', kind: 'write', baseRisk: 'yellow',
  description: '修改本人的银行卡备注，如工资卡、储蓄卡A。允许同名，但后续转账必须明确尾号。',
  inputSchema: z.object({ cardId: z.string(), remark: z.string().trim().max(30) }),
  summarize: async (a, ctx) => ({ title: '确认修改卡片备注', fields: [
    { label: '银行卡', value: cardLabel(await ownProfile(ctx.userId, a.cardId)) },
    { label: '新备注', value: a.remark || '无备注' },
  ] }),
  execute: (a, ctx) => saveCardRemark(ctx.userId, a.cardId, a.remark),
})

const repaySchema = z.object({ creditCardQuery: z.string().trim().min(1).max(100), sourceCardQuery: z.string().trim().min(1).max(100), amountCents: z.number().int().positive().max(100_000_000) })
type Repayment = z.infer<typeof repaySchema> & { creditCardId: string; sourceCardId: string }
export const repayCreditCard = defineBankTool({
  name: 'repay_credit_card', kind: 'write', baseRisk: 'yellow',
  description: '从本人的储蓄卡为本人信用卡还款，金额单位分，不能超过待还金额。卡片备注重名时必须询问尾号。',
  inputSchema: repaySchema,
  prepare: async (a, ctx) => ({ ...a, creditCardId: (await resolveCard(ctx.userId, a.creditCardQuery, 'credit')).id, sourceCardId: (await resolveCard(ctx.userId, a.sourceCardQuery, 'debit')).id }),
  summarize: async (input, ctx) => {
    const a = input as Repayment
    const [credit, source] = await Promise.all([ownProfile(ctx.userId, a.creditCardId), ownProfile(ctx.userId, a.sourceCardId)])
    if (credit.outstandingCents < a.amountCents) throw new Error('还款金额超过待还金额')
    if (source.balanceCents < a.amountCents) throw new Error('付款卡余额不足')
    return { title: '确认信用卡还款', fields: [
      { label: '信用卡', value: cardLabel(credit) }, { label: '付款卡', value: cardLabel(source) },
      { label: '还款金额', value: `¥${(a.amountCents / 100).toFixed(2)}` },
      { label: '待还金额', value: `¥${(credit.outstandingCents / 100).toFixed(2)}` },
    ] }
  },
  execute: (a, ctx) => repayCredit(a as Repayment, ctx),
})

export const applyCard = defineBankTool({
  name: 'apply_card', kind: 'write', baseRisk: 'yellow',
  description: '申请一张文财模拟银行卡，kind=debit 储蓄卡/credit 信用卡，可添加备注。须用户确认并在独立安全页面为这张新卡设置专属交易密码后才发卡，新卡独立账户零余额，模拟信用卡初始额度20000元。',
  inputSchema: z.object({ kind: z.enum(['debit', 'credit']), remark: z.string().trim().max(30).default('') }),
  summarize: async (a) => ({ title: '确认申请模拟银行卡', fields: [{ label: '类型', value: a.kind === 'credit' ? '信用卡' : '储蓄卡' }, { label: '备注', value: a.remark || '无备注' }, ...(a.kind === 'credit' ? [{ label: '初始模拟额度', value: '¥20,000.00' }] : []), { label: '说明', value: '文财模拟卡，创建独立零余额账户' }] }),
  execute: (a, ctx) => createUserCard(ctx.userId, a.kind, a.remark, ctx.authorization?.secureRequestId),
})
export const adjustCreditLimit = defineBankTool({
  name: 'adjust_credit_limit', kind: 'write', baseRisk: 'red',
  description: '调整本人模拟信用卡授信总额度，单位元，不能低于待还金额。不是每日交易限额，须强验证。',
  inputSchema: z.object({ cardId: z.string(), creditLimit: z.number().positive().max(200_000) }),
  summarize: async (a, ctx) => { const card = await ownProfile(ctx.userId, a.cardId); if (card.kind !== 'credit') throw new Error('请选择信用卡'); return { title: '确认调整信用额度', fields: [{ label: '信用卡', value: cardLabel(card) }, { label: '原额度', value: `¥${(card.creditLimitCents / 100).toFixed(2)}` }, { label: '新额度', value: `¥${a.creditLimit.toFixed(2)}` }] } },
  execute: (a, ctx) => changeCreditLimit(ctx.userId, a.cardId, Math.round(a.creditLimit * 100)),
  compensate: async (a, out, ctx) => { await changeCreditLimit(ctx.userId, a.cardId, Math.round(out.previousLimit * 100)) },
})
export const showBankCard = defineBankTool({
  name: 'show_bank_card', kind: 'read', baseRisk: 'green',
  description: '用户要查看卡号时，只调出本人的银行卡组件。按备注或尾号查询，重名必须询问尾号。输出没有完整卡号；用户点击眼睛打开独立安全页面，输入这张卡的交易密码验证，关闭页面后卡片获取结果。不要询问密码，不要再用 show_view 或文字显示卡号。',
  inputSchema: z.object({ query: z.string().trim().min(1).max(100) }),
  execute: async (a, ctx) => {
    const matches = await findCards(ctx.userId, a.query)
    if (matches.length !== 1) throw new Error(matches.length ? `请先询问具体尾号：${matches.map(cardLabel).join('；')}` : '没有找到这张银行卡')
    const card = matches[0]
    return { cardId: card.id, name: card.remark || (card.kind === 'credit' ? '信用卡' : '储蓄卡'), last4: card.last4, kind: card.kind, status: card.status }
  },
})
export const cardPasswordSettings = defineBankTool({
  name: 'card_password_settings', kind: 'read', baseRisk: 'green',
  description: '为用户打开某一张银行卡的密码设置入口，每张卡独立密码。按备注或尾号查找，重名必须询问具体尾号。用户在独立安全页面亲自设置并通过短信/Passkey验证，绝不能询问或记录密码。',
  inputSchema: z.object({ query: z.string().trim().min(1).max(100) }),
  execute: async (a, ctx) => {
    const cards = await findCards(ctx.userId, a.query)
    if (cards.length !== 1) throw new Error(cards.length ? `请询问具体尾号：${cards.map(cardLabel).join('；')}` : '还没有这张银行卡，请先申请新卡')
    return { cardId: cards[0].id, last4: cards[0].last4, remark: cards[0].remark }
  },
})
export const CARD_TOOLS = [resolveMyCards, showBankCard, cardPasswordSettings, transferBetweenCards, setCardRemark, repayCreditCard, applyCard, adjustCreditLimit]
