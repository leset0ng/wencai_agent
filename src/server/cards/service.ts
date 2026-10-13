import { randomInt, randomUUID } from 'node:crypto'
import { and, eq, gte, lt, sql } from 'drizzle-orm'
import { auth, db, schema, type DB } from '#/server/db/client'
import type { AgentContext } from '#/server/agent/context'
import { ensureCardNumber, ensureCardNumberSchema } from './numbers'
import { ensureCardPasswordSchema, migrateLegacyCardPassword } from './password'

let ready: Promise<void> | undefined
export function ensureCardSchema() {
  return ready ??= db.$client.execute(`CREATE TABLE IF NOT EXISTS bank_card_profiles (
    card_id TEXT PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
    remark TEXT NOT NULL DEFAULT '', credit_limit_cents INTEGER NOT NULL DEFAULT 0,
    outstanding_cents INTEGER NOT NULL DEFAULT 0, bill_day INTEGER NOT NULL DEFAULT 10,
    due_day INTEGER NOT NULL DEFAULT 28)`).then(() => {}).catch((e) => { ready = undefined; throw e })
}

export const cardKindName = (kind: string) => kind === 'credit' ? '信用卡' : '储蓄卡'
export const cardLabel = (card: { kind: string; remark: string; last4: string }) =>
  `${card.remark ? `${card.remark} · ` : ''}${cardKindName(card.kind)}尾号${card.last4}`

/** 原余额与所有历史流水留在第一张储蓄卡；其余卡创建零余额账户。可并发、可重复运行。 */
export async function ensureUserCardAccounts(userId: string) {
  await ensureCardSchema()
  await ensureCardNumberSchema()
  await ensureCardPasswordSchema()
  await db.transaction(async (tx) => {
    const cards = await tx.select().from(schema.cards).where(eq(schema.cards.userId, userId)).orderBy(sql`rowid`)
    const accounts = await tx.select().from(schema.accounts).where(eq(schema.accounts.userId, userId))
    for (const account of accounts) {
      const linked = cards.filter((c) => c.accountId === account.id)
      // 旧版把独立「储蓄账户」画成一张卡却没有 cards 记录，补齐真实卡记录以统一数量。
      if (!linked.length && account.name === '储蓄账户') {
        const id = `card_account_${account.id}`
        let last4: string
        do { last4 = String(randomInt(0, 10_000)).padStart(4, '0') } while (cards.some((c) => c.last4 === last4))
        const card = { id, userId, accountId: account.id, last4, kind: 'debit' as const, status: 'active' as const, dailyLimitCents: 5_000_000 }
        await tx.insert(schema.cards).values(card)
        await tx.insert(schema.bankCardProfiles).values({ cardId: id, remark: account.name })
        cards.push(card)
        continue
      }
      const firstDebit = linked.find((c) => c.kind === 'debit')
      for (const card of linked) {
        const [profile] = await tx.select().from(schema.bankCardProfiles).where(eq(schema.bankCardProfiles.cardId, card.id))
        // 已升级且独立绑定的卡无需迁移，也不会把日后产生的信用流水再次拆走。
        if (profile && linked.length === 1) continue
        let split = firstDebit ? card.id !== firstDebit.id : linked.length > 1
        if (!firstDebit && !profile && !split) {
          const [history] = await tx.select({ id: schema.transactions.id }).from(schema.transactions).where(eq(schema.transactions.accountId, account.id)).limit(1)
          split = account.balanceCents !== 0 || !!history
        }
        if (split) {
          const accountId = `acc_card_${card.id}`
          await tx.insert(schema.accounts).values({ id: accountId, userId, name: cardKindName(card.kind), balanceCents: 0, currency: account.currency })
          await tx.update(schema.cards).set({ accountId }).where(eq(schema.cards.id, card.id))
        }
        const remark = card.kind === 'debit' && !['储蓄卡', '借记卡', '信用卡', '银行卡'].includes(account.name) ? account.name : ''
        await tx.insert(schema.bankCardProfiles).values({ cardId: card.id, remark, creditLimitCents: card.kind === 'credit' ? 2_000_000 : 0 }).onConflictDoNothing()
      }
    }
    for (const card of cards) {
      await ensureCardNumber(tx, card.id, card.last4)
      await migrateLegacyCardPassword(tx, userId, card.id)
    }
  })
}

export async function userCards(userId: string) {
  await ensureUserCardAccounts(userId)
  return db.select({
    id: schema.cards.id, userId: schema.cards.userId, accountId: schema.cards.accountId,
    last4: schema.cards.last4, kind: schema.cards.kind, status: schema.cards.status,
    dailyLimitCents: schema.cards.dailyLimitCents, remark: schema.bankCardProfiles.remark,
    creditLimitCents: schema.bankCardProfiles.creditLimitCents,
    outstandingCents: schema.bankCardProfiles.outstandingCents,
    billDay: schema.bankCardProfiles.billDay, dueDay: schema.bankCardProfiles.dueDay,
    balanceCents: schema.accounts.balanceCents,
  }).from(schema.cards)
    .innerJoin(schema.accounts, and(eq(schema.accounts.id, schema.cards.accountId), eq(schema.accounts.userId, userId)))
    .innerJoin(schema.bankCardProfiles, eq(schema.cards.id, schema.bankCardProfiles.cardId))
    .where(eq(schema.cards.userId, userId)).orderBy(sql`cards.rowid`)
}
export type OwnedCard = Awaited<ReturnType<typeof userCards>>[number]

export async function ownProfile(userId: string, cardId: string) {
  const card = (await userCards(userId)).find((c) => c.id === cardId)
  if (!card) throw new Error('银行卡不存在或不属于你')
  return card
}

export async function findCards(userId: string, query: string, kind?: 'debit' | 'credit') {
  const value = query.normalize('NFKC').replace(/\s+/g, '').trim()
  const tail = value.match(/(?:尾号|末四位)(\d{4})/)?.[1] ?? (/^\d{4}$/.test(value) ? value : undefined)
  const inferred = kind ?? (value.includes('信用卡') ? 'credit' : /储蓄卡|借记卡/.test(value) ? 'debit' : undefined)
  const name = value.replace(/(?:尾号|末四位)\d{4}/g, '').replace(/^\d{4}$/, '').replace(/储蓄卡|借记卡|信用卡/g, '')
  return (await userCards(userId)).filter((c) => {
    if (inferred && c.kind !== inferred) return false
    if (tail && c.last4 !== tail) return false
    const remark = c.remark.normalize('NFKC').replace(/\s+/g, '')
    return !name || remark === value || remark === name || remark.replace(/储蓄卡|借记卡|信用卡/g, '') === name
  })
}
export async function resolveCard(userId: string, query: string, kind?: 'debit' | 'credit') {
  const matches = await findCards(userId, query, kind)
  if (!matches.length) throw new Error(`没有找到“${query}”，请核对卡片备注或尾号`)
  if (matches.length > 1) throw new Error(`“${query}”对应多张卡，请先询问用户具体哪张：${matches.map(cardLabel).join('；')}。不得自行选择。`)
  if (matches[0].status !== 'active') throw new Error(`${cardLabel(matches[0])}已冻结或挂失`)
  return matches[0]
}

export async function createUserCard(userId: string, kind: 'debit' | 'credit', remark = '', secureRequestId?: string) {
  const [registered] = await db.select().from(auth.baUser).where(eq(auth.baUser.id, userId))
  if (registered) await db.insert(schema.users).values({ id: userId, name: registered.name }).onConflictDoNothing()
  await ensureUserCardAccounts(userId)
  return db.transaction(async (tx) => {
    const [credential] = secureRequestId ? await tx.select().from(schema.bankSecureRequests).where(and(eq(schema.bankSecureRequests.id, secureRequestId), eq(schema.bankSecureRequests.userId, userId), eq(schema.bankSecureRequests.status, 'verified'))) : []
    if (secureRequestId && (!credential?.passwordHash || !credential.consumedAt || credential.expiresAt <= new Date())) throw new Error('新卡密码凭据无效，请重新申请')
    const existing = await tx.select().from(schema.cards).where(eq(schema.cards.userId, userId))
    let last4: string
    do { last4 = String(randomInt(0, 10_000)).padStart(4, '0') } while (existing.some((c) => c.last4 === last4))
    const id = `card_${randomUUID()}`, accountId = `acc_card_${id}`
    await tx.insert(schema.accounts).values({ id: accountId, userId, name: cardKindName(kind), balanceCents: 0 })
    await tx.insert(schema.cards).values({ id, userId, accountId, kind, last4, status: 'active', dailyLimitCents: 5_000_000 })
    await tx.insert(schema.bankCardProfiles).values({ cardId: id, remark, creditLimitCents: kind === 'credit' ? 2_000_000 : 0 })
    await ensureCardNumber(tx, id, last4)
    if (credential) {
      await tx.insert(schema.bankCardPasswords).values({ cardId: id, userId, passwordHash: credential.passwordHash! })
      await tx.update(schema.bankSecureRequests).set({ passwordHash: null, status: 'issued' }).where(eq(schema.bankSecureRequests.id, credential.id))
    }
    return { cardId: id, accountId, last4, kind }
  })
}

export async function changeCreditLimit(userId: string, cardId: string, limitCents: number) {
  const card = await ownProfile(userId, cardId)
  if (card.kind !== 'credit' || card.status === 'lost') throw new Error('请选择未挂失的本人信用卡')
  if (!Number.isSafeInteger(limitCents) || limitCents <= 0 || limitCents > 20_000_000) throw new Error('额度必须在 0.01 至 200000 元之间')
  const [updated] = await db.update(schema.bankCardProfiles).set({ creditLimitCents: limitCents }).where(and(eq(schema.bankCardProfiles.cardId, cardId), sql`${schema.bankCardProfiles.outstandingCents} <= ${limitCents}`)).returning()
  if (!updated) throw new Error('新额度不能低于当前待还金额')
  return { cardId, creditLimit: limitCents / 100, outstanding: updated.outstandingCents / 100, previousLimit: card.creditLimitCents / 100 }
}

type Transaction = Parameters<Parameters<DB['transaction']>[0]>[0]
/** 在扣款事务内检查卡片，避免确认后冻结仍能扣款；无卡资金账户沿用原账户规则。 */
export async function assertDebitAccount(tx: Transaction, accountId: string, amountCents = 0, now = new Date()) {
  const [card] = await tx.select().from(schema.cards).where(eq(schema.cards.accountId, accountId))
  if (!card) return
  if (card.kind !== 'debit') throw new Error('信用卡不支持普通转账，请使用信用卡还款')
  if (card.status !== 'active') throw new Error(`尾号${card.last4}已冻结或挂失`)
  if (amountCents) {
    const start = new Date(Math.floor((now.getTime() + 8 * 3600_000) / 86_400_000) * 86_400_000 - 8 * 3600_000)
    const rows = await tx.select().from(schema.transactions).where(and(eq(schema.transactions.accountId, accountId), gte(schema.transactions.occurredAt, start), lt(schema.transactions.occurredAt, new Date(start.getTime() + 86400_000))))
    const spent = rows.filter((r) => r.amountCents < 0 && ['转账', '信用卡还款'].includes(r.category)).reduce((sum, r) => sum - r.amountCents, 0)
    if (spent + amountCents > card.dailyLimitCents) throw new Error(`尾号${card.last4}超过每日转出限额`)
  }
}

export async function saveCardRemark(userId: string, cardId: string, remark: string) {
  await ownProfile(userId, cardId)
  const value = remark.trim()
  if (value.length > 30) throw new Error('备注最多 30 个字符')
  await db.update(schema.bankCardProfiles).set({ remark: value }).where(eq(schema.bankCardProfiles.cardId, cardId))
  return { cardId, remark: value }
}

/** 演示后台的信用消费：额度与欠款同一事务更新，流水只属于这张信用卡。 */
export async function creditSpend(userId: string, cardId: string, amountCents: number, merchant: string) {
  const card = await ownProfile(userId, cardId)
  if (card.kind !== 'credit') throw new Error('请选择信用卡')
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new Error('消费金额无效')
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(schema.cards).where(eq(schema.cards.id, cardId))
    const [owner] = await tx.select().from(schema.users).where(eq(schema.users.id, userId))
    if (current?.status !== 'active' || (owner?.lockedUntil && owner.lockedUntil > new Date())) throw new Error('卡片或账户已锁定')
    const [profile] = await tx.update(schema.bankCardProfiles).set({ outstandingCents: sql`${schema.bankCardProfiles.outstandingCents} + ${amountCents}` })
      .where(and(eq(schema.bankCardProfiles.cardId, cardId), sql`${schema.bankCardProfiles.outstandingCents} + ${amountCents} <= ${schema.bankCardProfiles.creditLimitCents}`)).returning()
    if (!profile) throw new Error('可用信用额度不足')
    const transactionId = `tx_${randomUUID()}`
    await tx.insert(schema.transactions).values({ id: transactionId, accountId: current.accountId, amountCents: -amountCents, counterparty: merchant, category: '信用卡消费', occurredAt: new Date() })
    return { transactionId, outstandingCents: profile.outstandingCents }
  })
}

export async function repayCredit(a: { creditCardId: string; sourceCardId: string; amountCents: number }, ctx: AgentContext) {
  await ensureUserCardAccounts(ctx.userId)
  if (!Number.isSafeInteger(a.amountCents) || a.amountCents <= 0 || a.amountCents > 100_000_000) throw new Error('还款金额无效')
  return db.transaction(async (tx) => {
    const cards = await tx.select().from(schema.cards).where(eq(schema.cards.userId, ctx.userId))
    const credit = cards.find((c) => c.id === a.creditCardId && c.kind === 'credit')
    const source = cards.find((c) => c.id === a.sourceCardId && c.kind === 'debit')
    if (!credit || !source) throw new Error('请选择本人的信用卡和储蓄卡')
    if (credit.status !== 'active') throw new Error('信用卡已冻结或挂失')
    const [owner] = await tx.select().from(schema.users).where(eq(schema.users.id, ctx.userId))
    if (owner?.lockedUntil && owner.lockedUntil > new Date()) throw new Error('账户已临时锁定')
    await assertDebitAccount(tx, source.accountId, a.amountCents)
    const [debt] = await tx.update(schema.bankCardProfiles).set({ outstandingCents: sql`${schema.bankCardProfiles.outstandingCents} - ${a.amountCents}` })
      .where(and(eq(schema.bankCardProfiles.cardId, credit.id), gte(schema.bankCardProfiles.outstandingCents, a.amountCents))).returning()
    if (!debt) throw new Error('还款金额超过待还金额，请重新核对')
    const [balance] = await tx.update(schema.accounts).set({ balanceCents: sql`${schema.accounts.balanceCents} - ${a.amountCents}` })
      .where(and(eq(schema.accounts.id, source.accountId), eq(schema.accounts.userId, ctx.userId), eq(schema.accounts.currency, 'CNY'), gte(schema.accounts.balanceCents, a.amountCents))).returning()
    if (!balance) throw new Error('付款卡余额不足或币种不支持')
    const transactionId = `repay_${randomUUID()}`, at = new Date()
    await tx.insert(schema.transactions).values([
      { id: transactionId, accountId: source.accountId, amountCents: -a.amountCents, counterparty: `信用卡尾号${credit.last4}`, category: '信用卡还款', occurredAt: at },
      { id: `${transactionId}_credit`, accountId: credit.accountId, amountCents: a.amountCents, counterparty: `储蓄卡尾号${source.last4}`, category: '信用卡还款', occurredAt: at },
    ])
    return { transactionId, amount: a.amountCents / 100, creditCardLast4: credit.last4, outstanding: debt.outstandingCents / 100, balanceAfter: balance.balanceCents / 100 }
  })
}
