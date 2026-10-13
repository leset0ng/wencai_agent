import { createHash, randomUUID } from 'node:crypto'
import { and, asc, desc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm'
import { generateText } from 'ai'
import { z } from 'zod'
import { db, schema, type DB } from '#/server/db/client'
import type { AgentContext } from '#/server/agent/context'
import { auditInTransaction } from '#/server/audit/log'
import { agentModel } from '#/server/llm/models'
import { ensurePaymentsSchema } from '#/server/payments/migrate'

type Transaction = Parameters<Parameters<DB['transaction']>[0]>[0]
export const RISK_REASON_TEXT = {
  distinct_payers: '短期内来自多名不同付款人的集中入账',
  rapid_outflow: '近期入账后较高比例的资金快速流出',
  high_incoming_count: '短期内收款笔数集中',
  new_owner: '账户所属用户注册时间较短',
} as const
export type RiskReasonCode = keyof typeof RISK_REASON_TEXT
const reasonCode = z.enum(['distinct_payers', 'rapid_outflow', 'high_incoming_count', 'new_owner'])
const verdictSchema = z.object({ suspicious: z.boolean(), signals: z.array(reasonCode).max(4) }).strict()
  .refine((value) => value.suspicious ? value.signals.length > 0 : value.signals.length === 0, '判断与信号不一致')
export type RiskVerdict = z.infer<typeof verdictSchema>

/** 唯一交给模型的数据：由 SQL 聚合的数字。不可增加姓名、账户编号、ID、备注或商户。 */
export interface RiskFeatures {
  /** accounts 没有开户时间；这里明确指所属认证用户注册天数，缺失时为 null。 */
  ownerAgeDays: number | null
  incomingCount24h: number
  incomingCents24h: number
  distinctPayers24h: number
  outgoingCents24h: number
  rapidOutflowRatio: number
}

let ready: Promise<void> | undefined
export function ensureRiskSchema(): Promise<void> {
  return (ready ??= (async () => {
    await ensurePaymentsSchema()
    for (const statement of [
      `CREATE TABLE IF NOT EXISTS bank_risk_flags (
        account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('suspected','confirmed','cleared')),
        features_json TEXT NOT NULL, reason_codes_json TEXT NOT NULL, snapshot_hash TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('ai','manual')), revision INTEGER NOT NULL DEFAULT 1,
        review_revision INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        reviewed_by TEXT, reviewed_at INTEGER)`,
      `CREATE TABLE IF NOT EXISTS bank_risk_analysis_state (
        account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        lease_token TEXT, lease_until INTEGER, next_run_at INTEGER NOT NULL,
        last_snapshot_hash TEXT, last_status TEXT NOT NULL DEFAULT 'idle', last_error_code TEXT,
        analyzed_at INTEGER)`,
      'CREATE INDEX IF NOT EXISTS bank_risk_analysis_due ON bank_risk_analysis_state(next_run_at)',
      'CREATE INDEX IF NOT EXISTS bank_risk_flag_status ON bank_risk_flags(status)',
    ]) await db.$client.execute(statement)
  })().catch((error) => { ready = undefined; throw error }))
}

/** Every source transaction must be matched to its credit; self-transfers, reversals and future rows are excluded. */
const incomingSql = `SELECT d.id, -d.amount_cents AS cents, d.occurred_at AS at, payer.user_id AS payer
  FROM bank_transfer_links l JOIN transactions d ON d.id=l.debit_transaction_id
  JOIN accounts payer ON payer.id=d.account_id JOIN accounts target ON target.id=l.target_account_id
  JOIN transactions c ON c.id=l.credit_transaction_id AND c.account_id=target.id
  WHERE target.id=? AND payer.user_id<>target.user_id AND (l.reversed_at IS NULL OR l.reversed_at>?)
    AND d.amount_cents<0 AND c.amount_cents=-d.amount_cents
    AND d.reversal_of IS NULL AND c.reversal_of IS NULL AND d.occurred_at<=? AND c.occurred_at<=?
    AND NOT EXISTS (SELECT 1 FROM transactions r WHERE r.reversal_of IN (d.id,c.id) AND r.occurred_at<=?)`
const outgoingSql = `SELECT t.id, -t.amount_cents AS cents, t.occurred_at AS at FROM transactions t
  JOIN accounts source ON source.id=t.account_id
  LEFT JOIN bank_transfer_links l ON l.debit_transaction_id=t.id
  LEFT JOIN accounts target ON target.id=l.target_account_id
  WHERE t.account_id=? AND t.amount_cents<0 AND t.occurred_at<=? AND t.reversal_of IS NULL
    AND (l.debit_transaction_id IS NULL OR l.reversed_at IS NULL OR l.reversed_at>?)
    AND (target.user_id IS NULL OR target.user_id<>source.user_id)
    AND NOT EXISTS (SELECT 1 FROM transactions r WHERE r.reversal_of=t.id AND r.occurred_at<=?)`

async function collectSnapshot(accountId: string, now: Date, tx?: Transaction) {
  const at = now.getTime(), since = at - 86_400_000
  const statement = {
    sql: `WITH incoming AS (${incomingSql}), outgoing AS (${outgoingSql})
      SELECT
        (SELECT COUNT(*) FROM incoming WHERE at>=?) AS incoming_count,
        (SELECT COALESCE(SUM(cents),0) FROM incoming WHERE at>=?) AS incoming_cents,
        (SELECT COUNT(DISTINCT payer) FROM incoming WHERE at>=?) AS distinct_payers,
        (SELECT COALESCE(SUM(cents),0) FROM outgoing WHERE at>=?) AS outgoing_cents,
        (SELECT COALESCE(SUM(o.cents),0) FROM outgoing o WHERE o.at>=? AND EXISTS
          (SELECT 1 FROM incoming i WHERE i.at>=? AND i.at<=o.at AND o.at-i.at<=7200000)) AS rapid_cents,
        (SELECT u.created_at FROM accounts a LEFT JOIN "user" u ON u.id=a.user_id WHERE a.id=?) AS owner_created_at,
        (SELECT COUNT(*) FROM incoming) AS snapshot_in_count,
        (SELECT COUNT(*) FROM outgoing) AS snapshot_out_count,
        (SELECT COALESCE(SUM(cents),0) FROM incoming) AS snapshot_in_cents,
        (SELECT COALESCE(SUM(cents),0) FROM outgoing) AS snapshot_out_cents,
        (SELECT id FROM incoming ORDER BY at DESC,id DESC LIMIT 1) AS snapshot_last_in,
        (SELECT id FROM outgoing ORDER BY at DESC,id DESC LIMIT 1) AS snapshot_last_out`,
    args: [accountId, at, at, at, at, accountId, at, at, at, since, since, since, since, since, since, accountId],
  }
  const parts = statement.sql.split('?'), query = sql.raw(parts[0])
  statement.args.forEach((arg, index) => { query.append(sql`${arg}`).append(sql.raw(parts[index + 1])) })
  const rows = tx ? await tx.all<Record<string, string | number | null>>(query) : (await db.$client.execute(statement)).rows
  const row = rows[0], incomingCents = Number(row.incoming_cents)
  const features: RiskFeatures = {
    ownerAgeDays: row.owner_created_at === null ? null : Math.max(0, Math.floor((at - Number(row.owner_created_at)) / 86_400_000)),
    incomingCount24h: Number(row.incoming_count), incomingCents24h: incomingCents,
    distinctPayers24h: Number(row.distinct_payers), outgoingCents24h: Number(row.outgoing_cents),
    rapidOutflowRatio: incomingCents === 0 ? 0 : Math.min(1, Number(row.rapid_cents) / incomingCents),
  }
  // Includes server-only activity identity, never sent to the model. Time passing alone cannot lift a manual clear.
  const snapshotHash = createHash('sha256').update(JSON.stringify([
    row.snapshot_in_count, row.snapshot_out_count, row.snapshot_in_cents, row.snapshot_out_cents,
    row.snapshot_last_in, row.snapshot_last_out,
  ])).digest('hex')
  return { features, snapshotHash }
}

export async function collectRiskFeatures(accountId: string, now = new Date()): Promise<RiskFeatures> {
  await ensureRiskSchema()
  return (await collectSnapshot(accountId, now)).features
}

export async function readAccountRiskFlag(accountId: string, tx?: Transaction) {
  if (!tx) await ensureRiskSchema()
  const [row] = await (tx ?? db).select().from(schema.bankRiskFlags).where(eq(schema.bankRiskFlags.accountId, accountId))
  return row ?? null
}

function cleanFeatures(value: RiskFeatures): RiskFeatures {
  // Whitelist keys even for internal callers; spreading an object into a model prompt is unsafe.
  const numeric = (n: number) => { if (!Number.isFinite(n) || n < 0) throw new Error('无效的风控聚合特征'); return n }
  return {
    ownerAgeDays: value.ownerAgeDays === null ? null : numeric(value.ownerAgeDays),
    incomingCount24h: numeric(value.incomingCount24h), incomingCents24h: numeric(value.incomingCents24h),
    distinctPayers24h: numeric(value.distinctPayers24h), outgoingCents24h: numeric(value.outgoingCents24h),
    rapidOutflowRatio: numeric(value.rapidOutflowRatio),
  }
}

/** AI's sole writer. There is intentionally no model-accessible review, delete or downgrade function. */
export async function addSuspectedRiskFlag(
  accountId: string, input: RiskFeatures, reasonCodes: RiskReasonCode[], observedReviewRevision?: number,
  options: { now?: Date; snapshotHash?: string } = {},
) {
  await ensureRiskSchema()
  const now = options.now ?? new Date(), features = cleanFeatures(input)
  const codes = [...new Set(z.array(reasonCode).min(1).max(4).parse(reasonCodes))]
  const snapshotHash = options.snapshotHash ?? (await collectSnapshot(accountId, now)).snapshotHash
  return db.transaction(async (tx) => {
    const existing = await readAccountRiskFlag(accountId, tx)
    if (existing?.status === 'confirmed') return { added: false, reason: 'confirmed' as const }
    if (observedReviewRevision !== undefined && (existing?.reviewRevision ?? 0) !== observedReviewRevision)
      return { added: false, reason: 'review_changed' as const }
    if (existing?.status === 'cleared' && (existing.snapshotHash === snapshotHash || observedReviewRevision === undefined))
      return { added: false, reason: 'cleared_snapshot' as const }
    if (existing?.status === 'suspected' && existing.snapshotHash === snapshotHash)
      return { added: false, reason: 'unchanged' as const }
    const revision = (existing?.revision ?? 0) + 1
    await tx.insert(schema.bankRiskFlags).values({ accountId, status: 'suspected', featuresJson: JSON.stringify(features),
      reasonCodesJson: JSON.stringify(codes), snapshotHash, source: 'ai', revision,
      reviewRevision: existing?.reviewRevision ?? 0, createdAt: now, updatedAt: now,
    }).onConflictDoUpdate({ target: schema.bankRiskFlags.accountId, set: {
      status: 'suspected', featuresJson: JSON.stringify(features), reasonCodesJson: JSON.stringify(codes),
      snapshotHash, source: 'ai', revision, updatedAt: now,
    } })
    const [account] = await tx.select().from(schema.accounts).where(eq(schema.accounts.id, accountId))
    await auditInTransaction(tx, { userId: account.userId, sessionId: `risk:${accountId}`, channel: 'web' }, 'risk_flag_added', {
      accountId, status: 'suspected', revision, features, reasonCodes: codes,
    })
    return { added: true, reason: 'suspected' as const, revision }
  })
}

export class RiskReviewConflict extends Error {
  constructor() { super('风险标记已更新，请刷新后重新复核'); this.name = 'RiskReviewConflict' }
}
export async function reviewAccountRiskFlag(input: {
  accountId: string; expectedRevision: number; decision: 'confirmed' | 'cleared'; reviewer: string
}, ctx: AgentContext) {
  await ensureRiskSchema()
  if (!['confirmed', 'cleared'].includes(input.decision) || !input.reviewer.trim()) throw new Error('复核参数无效')
  return db.transaction(async (tx) => {
    const existing = await readAccountRiskFlag(input.accountId, tx)
    if (!existing || existing.revision !== input.expectedRevision) throw new RiskReviewConflict()
    const now = new Date()
    // Same transaction: a clear covers activity already present, including activity added after the AI flag.
    const clearedSnapshot = input.decision === 'cleared' ? await collectSnapshot(input.accountId, now, tx) : undefined
    const rows = await tx.update(schema.bankRiskFlags).set({ status: input.decision, source: 'manual',
      revision: existing.revision + 1, reviewRevision: existing.reviewRevision + 1,
      reviewedBy: input.reviewer, reviewedAt: now, updatedAt: now,
      ...(clearedSnapshot ? { snapshotHash: clearedSnapshot.snapshotHash } : {}),
    }).where(and(eq(schema.bankRiskFlags.accountId, input.accountId), eq(schema.bankRiskFlags.revision, input.expectedRevision))).returning()
    if (!rows.length) throw new RiskReviewConflict()
    await auditInTransaction(tx, ctx, 'risk_flag_reviewed', { accountId: input.accountId,
      from: existing.status, to: input.decision, status: input.decision, revision: rows[0].revision,
      reviewer: input.reviewer, features: cleanFeatures(JSON.parse(existing.featuresJson)),
      reasonCodes: z.array(reasonCode).parse(JSON.parse(existing.reasonCodesJson)),
    })
    return rows[0]
  })
}

export async function listAccountRiskFlags(userId?: string) {
  await ensureRiskSchema()
  const rows = await db.select({ flag: schema.bankRiskFlags, userId: schema.accounts.userId,
    ownerName: schema.users.name, accountName: schema.accounts.name,
  }).from(schema.bankRiskFlags).innerJoin(schema.accounts, eq(schema.accounts.id, schema.bankRiskFlags.accountId))
    .innerJoin(schema.users, eq(schema.users.id, schema.accounts.userId))
    .where(userId ? eq(schema.accounts.userId, userId) : undefined)
  return rows.sort((a, b) => b.flag.updatedAt.getTime() - a.flag.updatedAt.getTime()).map(({ flag, ...owner }) => ({
    ...owner, accountId: flag.accountId, status: flag.status, revision: flag.revision,
    features: cleanFeatures(JSON.parse(flag.featuresJson)),
    reasons: (JSON.parse(flag.reasonCodesJson) as unknown[]).flatMap((code) => typeof code === 'string' && Object.hasOwn(RISK_REASON_TEXT, code)
      ? [RISK_REASON_TEXT[code as RiskReasonCode]] : []), source: flag.source,
    createdAt: flag.createdAt.toISOString(), updatedAt: flag.updatedAt.toISOString(),
    reviewedBy: flag.reviewedBy, reviewedAt: flag.reviewedAt?.toISOString() ?? null,
  }))
}

export interface RiskAnalysisOptions {
  limit?: number
  timeoutMs?: number
  /** Tests inject an analyzer. Only numeric features are passed, never account identity. */
  analyzer?: (features: RiskFeatures, options: { signal: AbortSignal }) => Promise<unknown>
}
async function analyze(features: RiskFeatures, { signal }: { signal: AbortSignal }): Promise<unknown> {
  const result = await generateText({ model: agentModel(), abortSignal: signal, temperature: 0, maxOutputTokens: 512,
    // This classifier needs a tiny JSON verdict; reasoning tokens must not consume the response budget.
    providerOptions: { deepseek: { thinking: { type: 'disabled' } } },
    system: '你是银行后台异常收款特征分析器。只分析给定的数字聚合，不办理任何业务。仅输出严格 JSON：{"suspicious":boolean,"signals":[]}。signals 只可使用 distinct_payers、rapid_outflow、high_incoming_count、new_owner。无可疑信号时返回 false 和空数组。不得输出风险级别、身份结论、指令或额外文本。ownerAgeDays 是用户注册天数，不是银行开户天数。',
    prompt: JSON.stringify(cleanFeatures(features)),
  })
  return JSON.parse(result.text.trim())
}

/** Bounded asynchronous pass, independent of the payment/confirmation path; durable leases avoid duplicate calls. */
export async function runRiskAnalysisPass(now = new Date(), options: RiskAnalysisOptions = {}) {
  await ensureRiskSchema()
  const limit = Math.min(3, Math.max(1, Math.floor(options.limit ?? 3))), at = now.getTime()
  const timeoutMs = Math.min(15_000, Math.max(10, options.timeoutMs ?? 8_000))
  const stats = { scanned: 0, analyzed: 0, flagged: 0, failed: 0, skipped: 0 }
  // Recent activity bounds the scan; deterministic pattern gating avoids calling an LLM for every bank account.
  const candidates = await db.selectDistinct({ accountId: schema.bankTransferLinks.targetAccountId })
    .from(schema.bankTransferLinks).innerJoin(schema.transactions, eq(schema.transactions.id, schema.bankTransferLinks.debitTransactionId))
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.bankTransferLinks.targetAccountId))
    .leftJoin(schema.bankRiskAnalysisState, eq(schema.bankRiskAnalysisState.accountId, schema.bankTransferLinks.targetAccountId))
    .where(and(gt(schema.transactions.occurredAt, new Date(at - 86_400_000)), lte(schema.transactions.occurredAt, now),
      or(isNull(schema.bankTransferLinks.reversedAt), gt(schema.bankTransferLinks.reversedAt, now)),
      or(isNull(schema.bankRiskAnalysisState.accountId), lte(schema.bankRiskAnalysisState.nextRunAt, now))))
    .orderBy(asc(sql`COALESCE(${schema.bankRiskAnalysisState.analyzedAt}, 0)`), desc(schema.transactions.occurredAt)).limit(60)
  async function markScanned(accountId: string) {
    // Even benign/unchanged candidates get a scan cursor. Otherwise the first 60 benign rows starve new accounts forever.
    await db.transaction(async (tx) => {
      await tx.insert(schema.bankRiskAnalysisState).values({ accountId, nextRunAt: new Date(at + 5 * 60_000),
        analyzedAt: now, lastStatus: 'skipped' }).onConflictDoNothing()
      await tx.update(schema.bankRiskAnalysisState).set({ nextRunAt: new Date(at + 5 * 60_000),
        analyzedAt: now, lastStatus: 'skipped', leaseToken: null, leaseUntil: null,
      }).where(and(eq(schema.bankRiskAnalysisState.accountId, accountId),
        lte(schema.bankRiskAnalysisState.nextRunAt, now),
        or(isNull(schema.bankRiskAnalysisState.leaseUntil), lte(schema.bankRiskAnalysisState.leaseUntil, now))))
    })
  }
  for (const { accountId } of candidates) {
    if (stats.analyzed >= limit) break
    if (!accountId) continue
    stats.scanned++
    const { features, snapshotHash } = await collectSnapshot(accountId, now)
    if (features.incomingCount24h < 5 || features.distinctPayers24h < 3 || features.incomingCents24h < 100_000 || features.rapidOutflowRatio < 0.7) {
      await markScanned(accountId); stats.skipped++; continue
    }
    const leaseToken = randomUUID()
    const lease = await db.transaction(async (tx) => {
      const flag = await readAccountRiskFlag(accountId, tx)
      if (flag?.status === 'confirmed' || flag?.snapshotHash === snapshotHash) return null
      await tx.insert(schema.bankRiskAnalysisState).values({ accountId, nextRunAt: new Date(0) }).onConflictDoNothing()
      const [state] = await tx.select().from(schema.bankRiskAnalysisState).where(eq(schema.bankRiskAnalysisState.accountId, accountId))
      if (state.lastSnapshotHash === snapshotHash || state.nextRunAt.getTime() > at) return null
      const acquired = await tx.update(schema.bankRiskAnalysisState).set({ leaseToken, leaseUntil: new Date(at + timeoutMs + 30_000), lastStatus: 'running' })
        .where(and(eq(schema.bankRiskAnalysisState.accountId, accountId), or(isNull(schema.bankRiskAnalysisState.leaseUntil), lte(schema.bankRiskAnalysisState.leaseUntil, now)))).returning()
      return acquired.length ? { reviewRevision: flag?.reviewRevision ?? 0 } : null
    })
    if (!lease) { await markScanned(accountId); stats.skipped++; continue }
    stats.analyzed++
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    try {
      const raw = await Promise.race([
        (options.analyzer ?? analyze)(cleanFeatures(features), { signal: controller.signal }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => {
          controller.abort(); reject(new Error('risk_analysis_timeout'))
        }, timeoutMs) }),
      ])
      const verdict = verdictSchema.parse(raw)
      // Signal codes are model proposals; only signals supported by these SQL features may be recorded.
      const supported = verdict.signals.filter((s) => s === 'distinct_payers' ? features.distinctPayers24h >= 3
        : s === 'rapid_outflow' ? features.rapidOutflowRatio >= 0.7
          : s === 'high_incoming_count' ? features.incomingCount24h >= 5 : features.ownerAgeDays !== null && features.ownerAgeDays <= 30)
      if (verdict.suspicious && supported.length) {
        const result = await addSuspectedRiskFlag(accountId, features, supported, lease.reviewRevision, { now, snapshotHash })
        if (result.added) stats.flagged++
      }
      await db.update(schema.bankRiskAnalysisState).set({ leaseToken: null, leaseUntil: null,
        nextRunAt: new Date(at + 45 * 60_000), lastSnapshotHash: snapshotHash, lastStatus: 'succeeded', lastErrorCode: null, analyzedAt: now,
      }).where(and(eq(schema.bankRiskAnalysisState.accountId, accountId), eq(schema.bankRiskAnalysisState.leaseToken, leaseToken)))
    } catch (error) {
      stats.failed++
      const errorCode = error instanceof z.ZodError || error instanceof SyntaxError ? 'invalid_response'
        : controller.signal.aborted ? 'timeout' : 'model_unavailable'
      // Fixed error codes only; upstream exception messages may contain provider secrets or raw response prose.
      await db.transaction(async (tx) => {
        await tx.update(schema.bankRiskAnalysisState).set({ leaseToken: null, leaseUntil: null,
          nextRunAt: new Date(at + 15 * 60_000), lastStatus: 'failed', lastErrorCode: errorCode, analyzedAt: now,
        }).where(and(eq(schema.bankRiskAnalysisState.accountId, accountId), eq(schema.bankRiskAnalysisState.leaseToken, leaseToken)))
        const [account] = await tx.select().from(schema.accounts).where(eq(schema.accounts.id, accountId))
        await auditInTransaction(tx, { userId: account.userId, sessionId: `risk:${accountId}`, channel: 'web' }, 'risk_analysis_failed', { accountId, errorCode })
      })
    } finally { clearTimeout(timer) }
  }
  return stats
}
