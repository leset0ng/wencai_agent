import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { and, eq, gte, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { AgentContext } from '#/server/agent/context'
import { auth, db, schema, type DB } from '#/server/db/client'
import { env } from '#/server/env'
import { ensurePaymentsSchema } from './migrate'
import { assertDebitAccount, cardLabel, ensureUserCardAccounts, userCards } from '#/server/cards/service'
import { ensureRiskSchema } from '#/server/risk/accounts'
import { assertRecipientRisk } from '#/server/risk/recipient'
import { ensureCardNumberSchema, numberFingerprint } from '#/server/cards/numbers'

export const maskAccount = (no: string) => `${no.slice(0, 4)} **** ${no.slice(-4)}`
export const lookupSchema = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('phone'),
    phoneNumber: z
      .string()
      .trim()
      .regex(/^1\d{10}$/, '请输入完整的 11 位手机号'),
  }),
  z.object({
    method: z.literal('account'),
    accountNo: z
      .string()
      .trim()
      .regex(/^\d{16}$/, '请输入完整的 16 位文财账号'),
    name: z.string().trim().min(1).max(60),
  }),
])

export async function paymentAccounts(userId: string) {
  await ensurePaymentsSchema()
  const cards = await userCards(userId)
  const accounts = await db.select().from(schema.accounts).where(eq(schema.accounts.userId, userId))
  for (const account of accounts) {
    // 主键解决并发生成同一账户账号的问题；号码碰撞时重新生成。
    for (let attempt = 0; attempt < 5; attempt++) {
      await db
        .insert(schema.bankAccountAddresses)
        .values({
          accountId: account.id,
          accountNo: `8800${String(randomInt(0, 1_000_000_000_000)).padStart(12, '0')}`,
        })
        .onConflictDoNothing()
      const [address] = await db
        .select()
        .from(schema.bankAccountAddresses)
        .where(eq(schema.bankAccountAddresses.accountId, account.id))
      if (address) break
      if (attempt === 4) throw new Error('收款账号生成失败，请重试')
    }
  }
  const [owner] = await db.select().from(schema.users).where(eq(schema.users.id, userId))
  return db
    .select({
      id: schema.accounts.id,
      name: schema.accounts.name,
      balanceCents: schema.accounts.balanceCents,
      currency: schema.accounts.currency,
      accountNo: schema.bankAccountAddresses.accountNo,
    })
    .from(schema.accounts)
    .innerJoin(
      schema.bankAccountAddresses,
      eq(schema.accounts.id, schema.bankAccountAddresses.accountId),
    )
    .where(eq(schema.accounts.userId, userId))
    .then((rows) =>
      rows.filter((a) => !cards.some((c) => c.accountId === a.id && c.kind === 'credit')).map((a) => {
        const card = cards.find((c) => c.accountId === a.id)
        return { ...a, name: card ? cardLabel(card) : a.name, cardLast4: card?.last4,
          cardId: card?.id, remark: card?.remark ?? '', ownerName: owner?.name ?? '', bank: '文财银行' }
      }),
    )
}

export async function listPaymentPayees(userId: string) {
  await ensurePaymentsSchema()
  return db
    .select({
      id: schema.payees.id,
      name: schema.payees.name,
      alias: schema.payees.alias,
      bank: schema.payees.bank,
      accountNo: schema.payees.accountNo,
      target: schema.bankPayeeLinks.targetAccountId,
    })
    .from(schema.payees)
    .leftJoin(schema.bankPayeeLinks, eq(schema.payees.id, schema.bankPayeeLinks.payeeId))
    .where(eq(schema.payees.userId, userId))
    .then((rows) =>
      rows.map(({ accountNo, target, ...p }) => ({
        ...p,
        account: maskAccount(accountNo),
        internal: !!target,
      })),
    )
}

const referenceSchema = z.object({
  userId: z.string(),
  targetAccountId: z.string(),
  accountNo: z.string(),
  name: z.string(),
  expiresAt: z.number(),
})
function sign(payload: string) {
  return createHmac('sha256', env.CONFIRM_SECRET)
    .update(`bank-recipient:${payload}`)
    .digest('base64url')
}
function recipientReference(
  userId: string,
  target: { id: string; accountNo: string; ownerName: string },
) {
  const payload = Buffer.from(
    JSON.stringify({
      userId,
      targetAccountId: target.id,
      accountNo: target.accountNo,
      name: target.ownerName,
      expiresAt: Date.now() + 15 * 60_000,
    }),
  ).toString('base64url')
  return `${payload}.${sign(payload)}`
}

export async function resolveRecipientReference(reference: string, userId: string) {
  await ensurePaymentsSchema()
  const [payload, signature, extra] = reference.split('.')
  if (!payload || !signature || extra) throw new Error('收款账户选择无效，请重新查找')
  const expected = Buffer.from(sign(payload))
  const supplied = Buffer.from(signature)
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied))
    throw new Error('收款账户选择无效，请重新查找')
  let value: z.infer<typeof referenceSchema>
  try {
    value = referenceSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString()))
  } catch {
    throw new Error('收款账户选择无效，请重新查找')
  }
  if (value.userId !== userId || value.expiresAt <= Date.now())
    throw new Error('收款账户选择已失效，请重新查找')
  const [target] = await db
    .select({
      id: schema.accounts.id,
      userId: schema.accounts.userId,
      currency: schema.accounts.currency,
      name: schema.users.name,
      accountNo: schema.bankAccountAddresses.accountNo,
    })
    .from(schema.accounts)
    .innerJoin(schema.users, eq(schema.users.id, schema.accounts.userId))
    .innerJoin(
      schema.bankAccountAddresses,
      eq(schema.bankAccountAddresses.accountId, schema.accounts.id),
    )
    .where(eq(schema.accounts.id, value.targetAccountId))
  if (!target || target.accountNo !== value.accountNo || target.name !== value.name)
    throw new Error('收款账户信息已变更，请重新查找')
  await ensureUserCardAccounts(target.userId)
  const [card] = await db.select().from(schema.cards).where(eq(schema.cards.accountId, target.id))
  if (card && (card.kind !== 'debit' || card.status !== 'active')) throw new Error('收款卡不可用，请重新选择储蓄卡')
  if (target.userId === userId) throw new Error('本人账户请使用“本人互转”')
  return target
}

export async function searchBankAccounts(input: z.infer<typeof lookupSchema>, ctx: AgentContext) {
  await ensurePaymentsSchema()
  let ownerId: string | undefined
  let cardAccountId: string | undefined
  if (input.method === 'phone') {
    const [owner] = await db
      .select({ id: auth.baUser.id })
      .from(auth.baUser)
      .where(eq(auth.baUser.phoneNumber, input.phoneNumber))
    ownerId = owner?.id

  } else {
    const [owner] = await db
      .select({ id: schema.accounts.userId })
      .from(schema.bankAccountAddresses)
      .innerJoin(schema.accounts, eq(schema.accounts.id, schema.bankAccountAddresses.accountId))
      .innerJoin(schema.users, eq(schema.users.id, schema.accounts.userId))
      .where(
        and(
          eq(schema.bankAccountAddresses.accountNo, input.accountNo),
          eq(schema.users.name, input.name),
        ),
      )
    ownerId = owner?.id
    if (!ownerId) {
      await ensureCardNumberSchema()
      const [cardOwner] = await db.select({ id: schema.cards.userId, accountId: schema.cards.accountId }).from(schema.bankCardNumbers)
        .innerJoin(schema.cards, eq(schema.cards.id, schema.bankCardNumbers.cardId))
        .innerJoin(schema.users, eq(schema.users.id, schema.cards.userId))
        .where(and(eq(schema.bankCardNumbers.fingerprint, numberFingerprint(input.accountNo)), eq(schema.users.name, input.name), eq(schema.cards.kind, 'debit'), eq(schema.cards.status, 'active')))
      ownerId = cardOwner?.id
      cardAccountId = cardOwner?.accountId
    }
  }
  if (!ownerId) return { candidates: [] }
  if (ownerId === ctx.userId) throw new Error('这是您本人的账户，请使用“本人互转”')
  const accounts = await paymentAccounts(ownerId)
  return {
    candidates: accounts
      .filter(
        (a) =>
          a.currency === 'CNY' && (input.method === 'phone' || a.id === cardAccountId || a.accountNo === input.accountNo),
      )
      .map((a) => ({
        name: a.ownerName,
        accountName: a.name,
        account: maskAccount(a.accountNo),
        bank: a.bank,
        reference: recipientReference(ctx.userId, a),
      })),
  }
}

export async function addPaymentPayee(
  reference: string,
  alias: string | undefined,
  ctx: AgentContext,
) {
  const target = await resolveRecipientReference(reference, ctx.userId)
  const [owner] = await db
    .select({ phone: auth.baUser.phoneNumber })
    .from(auth.baUser)
    .where(eq(auth.baUser.id, target.userId))
  const id = `p_${randomUUID()}`
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(schema.bankPayeeLinks)
      .where(
        and(
          eq(schema.bankPayeeLinks.userId, ctx.userId),
          eq(schema.bankPayeeLinks.targetAccountId, target.id),
        ),
      )
    if (existing) throw new Error('该账户已在您的收款人列表中')
    await tx.insert(schema.payees).values({
      id,
      userId: ctx.userId,
      name: target.name,
      alias: alias?.trim() || null,
      accountNo: target.accountNo,
      bank: '文财银行',
      phone: owner?.phone ?? null,
      createdAt: new Date(),
    })
    await tx
      .insert(schema.bankPayeeLinks)
      .values({ payeeId: id, userId: ctx.userId, targetAccountId: target.id })
    return {
      payeeId: id,
      name: target.name,
      account: maskAccount(target.accountNo),
      bank: '文财银行',
    }
  })
}

export type TransferInput = {
  fromAccountId: string
  payeeId?: string
  toAccountId?: string
  amountCents: number
  memo?: string
}
export async function transferSummary(a: TransferInput, ctx: AgentContext) {
  const own = await paymentAccounts(ctx.userId)
  const source = own.find((x) => x.id === a.fromAccountId)
  if (!source) throw new Error('付款账户不存在')
  let name: string, account: string
  if (a.toAccountId) {
    const target = own.find((x) => x.id === a.toAccountId)
    if (!target || target.id === source.id) throw new Error('请选择不同的本人收款账户')
    name = target.name
    account = maskAccount(target.accountNo)
  } else {
    const [target] = await db
      .select()
      .from(schema.payees)
      .where(and(eq(schema.payees.id, a.payeeId ?? ''), eq(schema.payees.userId, ctx.userId)))
    if (!target) throw new Error('收款人不存在')
    name = target.name
    account = `${target.bank} ${maskAccount(target.accountNo)}`
  }
  if (!Number.isSafeInteger(a.amountCents) || a.amountCents <= 0 || a.amountCents > 100_000_000)
    throw new Error('转账金额无效，单笔最多 100 万元')
  if (source.balanceCents < a.amountCents) throw new Error('付款账户余额不足')
  return {
    title: a.toAccountId ? '确认本人账户互转' : '确认转账',
    fields: [
      { label: '金额', value: `¥${(a.amountCents / 100).toFixed(2)}` },
      { label: '收款人 / 账户', value: name },
      { label: '收款账号', value: account },
      {
        label: '付款账户',
        value: `${source.name} ${maskAccount(source.accountNo)}`,
      },
      ...(a.memo ? [{ label: '备注', value: a.memo }] : []),
    ],
  }
}

/** 条件扣款与双边流水必须处在同一个事务内，避免超扣或只扣不入账。 */
export async function settleTransfer(a: TransferInput, ctx: AgentContext, occurredAt = new Date(), options?: {
  /** 仅银行内部 AA 请求服务可指定收款归属，工具参数不能传入。 */
  targetUserId?: string
  onSettled?: (tx: Parameters<Parameters<DB['transaction']>[0]>[0], transactionId: string) => Promise<void>
}) {
  await ensurePaymentsSchema()
  await ensureRiskSchema()
  await ensureUserCardAccounts(ctx.userId)
  if (ctx.authorization) await (await import('#/server/automation/service')).ensureAutomationSchema()
  if (
    !Number.isSafeInteger(a.amountCents) ||
    a.amountCents <= 0 ||
    a.amountCents > 100_000_000 ||
    !!a.payeeId === !!a.toAccountId
  )
    throw new Error('转账参数无效')
  return db.transaction(async (tx) => {
    const [source] = await tx
      .select()
      .from(schema.accounts)
      .where(and(eq(schema.accounts.id, a.fromAccountId), eq(schema.accounts.userId, ctx.userId)))
    const [sender] = await tx.select().from(schema.users).where(eq(schema.users.id, ctx.userId))
    if (!source) throw new Error('付款账户不存在')
    await assertDebitAccount(tx, source.id, a.amountCents, occurredAt)
    if (sender?.lockedUntil && sender.lockedUntil > new Date()) throw new Error('账户已临时锁定')
    let targetId = a.toAccountId,
      payeeName = '',
      payeeAccount = ''
    let riskTargetId = targetId
    if (a.payeeId) {
      const [payee] = await tx
        .select()
        .from(schema.payees)
        .where(and(eq(schema.payees.id, a.payeeId), eq(schema.payees.userId, ctx.userId)))
      if (!payee) throw new Error('收款人不存在')
      const [link] = await tx
        .select()
        .from(schema.bankPayeeLinks)
        .where(
          and(
            eq(schema.bankPayeeLinks.payeeId, payee.id),
            eq(schema.bankPayeeLinks.userId, ctx.userId),
          ),
        )
      if (payee.bank === '文财银行' && !link) throw new Error('收款账户已失效，请重新添加收款人')
      targetId = link?.targetAccountId
      const [riskAddress] = await tx.select().from(schema.bankAccountAddresses).where(eq(schema.bankAccountAddresses.accountNo, payee.accountNo))
      riskTargetId = riskAddress?.accountId ?? targetId
      payeeName = payee.name
      payeeAccount = maskAccount(payee.accountNo)
      if (targetId) {
        const [address] = await tx
          .select()
          .from(schema.bankAccountAddresses)
          .where(eq(schema.bankAccountAddresses.accountId, targetId))
        if (address?.accountNo !== payee.accountNo) throw new Error('收款账户信息已变更')
      }
    }
    if (targetId === source.id) throw new Error('付款与收款账户不能相同')
    const target = targetId
      ? (await tx.select().from(schema.accounts).where(eq(schema.accounts.id, targetId)))[0]
      : undefined
    if (targetId && !target) throw new Error('收款账户不存在')
    if (a.toAccountId && target?.userId !== ctx.userId && target?.userId !== options?.targetUserId)
      throw new Error('本人互转只能选择本人的账户')
    if (source.currency !== 'CNY' || (target && target.currency !== source.currency))
      throw new Error('目前仅支持人民币同币种转账')
    if (target) {
      await assertDebitAccount(tx, target.id)
      const [owner] = await tx.select().from(schema.users).where(eq(schema.users.id, target.userId))
      if (a.payeeId && owner?.name !== payeeName) throw new Error('收款户名已变更，请重新添加')
      payeeName = a.toAccountId ? target.name : payeeName
      if (a.toAccountId) {
        const [address] = await tx
          .select()
          .from(schema.bankAccountAddresses)
          .where(eq(schema.bankAccountAddresses.accountId, target.id))
        payeeAccount = address ? maskAccount(address.accountNo) : ''
      }
      if (!Number.isSafeInteger(target.balanceCents + a.amountCents))
        throw new Error('收款账户金额超出范围')
    }
    await assertRecipientRisk(tx, riskTargetId, ctx.authorization)
    const [updated] = await tx
      .update(schema.accounts)
      .set({
        balanceCents: sql`${schema.accounts.balanceCents} - ${a.amountCents}`,
      })
      .where(
        and(
          eq(schema.accounts.id, source.id),
          eq(schema.accounts.userId, ctx.userId),
          gte(schema.accounts.balanceCents, a.amountCents),
        ),
      )
      .returning()
    if (!updated) throw new Error('付款账户余额不足')
    const id = `tx_${randomUUID()}`,
      creditId = target ? `${id}_credit` : null
    await tx.insert(schema.transactions).values({
      id,
      accountId: source.id,
      amountCents: -a.amountCents,
      counterparty: payeeName,
      memo: a.memo ?? null,
      category: '转账',
      occurredAt,
    })
    if (target && creditId) {
      await tx
        .update(schema.accounts)
        .set({
          balanceCents: sql`${schema.accounts.balanceCents} + ${a.amountCents}`,
        })
        .where(eq(schema.accounts.id, target.id))
      await tx.insert(schema.transactions).values({
        id: creditId,
        accountId: target.id,
        amountCents: a.amountCents,
        counterparty: sender?.name ?? source.name,
        memo: a.memo ?? null,
        category: '转账',
        occurredAt,
      })
    }
    await tx.insert(schema.bankTransferLinks).values({
      debitTransactionId: id,
      targetAccountId: target?.id ?? null,
      creditTransactionId: creditId,
    })
    await options?.onSettled?.(tx, id)
    const receipt = {
      transactionId: id,
      amount: a.amountCents / 100,
      payee: payeeName,
      account: payeeAccount,
      fromAccount: source.name,
      balanceAfter: updated.balanceCents / 100,
      settlement: target ? 'internal' : 'external',
    }
    if (ctx.authorization) {
      const [link] = await tx.select().from(schema.bankTaskApprovals).where(eq(schema.bankTaskApprovals.actionId, ctx.authorization.actionId))
      if (link) await tx.update(schema.scheduledTasks).set({ status: 'succeeded', resultJson: JSON.stringify(receipt) }).where(and(eq(schema.scheduledTasks.id, link.taskId), eq(schema.scheduledTasks.userId, ctx.userId), eq(schema.scheduledTasks.status, 'awaiting_confirmation')))
    }
    return receipt
  })
}

export async function reverseTransfer(transactionId: string, ctx: AgentContext) {
  await ensurePaymentsSchema()
  await db.transaction(async (tx) => {
    const [original] = await tx
      .select({
        transaction: schema.transactions,
        owner: schema.accounts.userId,
      })
      .from(schema.transactions)
      .innerJoin(schema.accounts, eq(schema.accounts.id, schema.transactions.accountId))
      .where(eq(schema.transactions.id, transactionId))
    const [link] = await tx
      .select()
      .from(schema.bankTransferLinks)
      .where(eq(schema.bankTransferLinks.debitTransactionId, transactionId))
    if (
      !original ||
      original.owner !== ctx.userId ||
      original.transaction.amountCents >= 0 ||
      !link
    )
      throw new Error('原转账不存在')
    const [claimed] = await tx
      .update(schema.bankTransferLinks)
      .set({ reversedAt: new Date() })
      .where(
        and(
          eq(schema.bankTransferLinks.debitTransactionId, transactionId),
          isNull(schema.bankTransferLinks.reversedAt),
        ),
      )
      .returning()
    if (!claimed) throw new Error('该转账已冲正')
    const row = original.transaction,
      cents = -row.amountCents,
      at = new Date()
    if (link.targetAccountId && link.creditTransactionId) {
      const [target] = await tx
        .update(schema.accounts)
        .set({ balanceCents: sql`${schema.accounts.balanceCents} - ${cents}` })
        .where(
          and(
            eq(schema.accounts.id, link.targetAccountId),
            gte(schema.accounts.balanceCents, cents),
          ),
        )
        .returning()
      if (!target) throw new Error('收款账户余额不足，无法自动冲正，请人工处理')
      await tx.insert(schema.transactions).values({
        id: `${transactionId}_reverse_credit`,
        accountId: target.id,
        amountCents: -cents,
        counterparty: '转账冲正',
        memo: '冲正',
        category: '冲正',
        occurredAt: at,
        reversalOf: link.creditTransactionId,
      })
    }
    await tx
      .update(schema.accounts)
      .set({ balanceCents: sql`${schema.accounts.balanceCents} + ${cents}` })
      .where(eq(schema.accounts.id, row.accountId))
    await tx.insert(schema.transactions).values({
      id: `${transactionId}_reverse`,
      accountId: row.accountId,
      amountCents: cents,
      counterparty: row.counterparty,
      memo: '冲正',
      category: '冲正',
      occurredAt: at,
      reversalOf: row.id,
    })
  })
}
