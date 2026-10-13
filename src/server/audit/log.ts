import { asc, desc } from 'drizzle-orm'
import { db, schema } from '#/server/db/client'
import { GENESIS_HASH, hashEntry, verifyChain } from './chain'
import type { AuditEntry, AuditType, StoredAuditEntry } from './chain'
import type { AgentContext } from '#/server/agent/context'

// 进程内排队，数据库写事务同时约束 Web 与自动任务进程，避免哈希链分叉。
let tail: Promise<unknown> = Promise.resolve()

export type AuditTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** Business changes and their evidence commit together; never call outer db from this helper. */
export async function auditInTransaction(tx: AuditTransaction, ctx: AgentContext, type: AuditType, payload: unknown, at = Date.now()): Promise<void> {
  const entry: AuditEntry = {
    at,
    userId: ctx.userId,
    sessionId: ctx.sessionId,
    channel: ctx.channel,
    type,
    // 先归一化为纯 JSON（Date → 字符串、去掉 undefined），保证写入前后哈希一致
    payload: JSON.parse(JSON.stringify(payload ?? null)),
  }
  const [last] = await tx
    .select({ hash: schema.auditLogs.hash })
    .from(schema.auditLogs)
    .orderBy(desc(schema.auditLogs.seq))
    .limit(1)
  const prevHash = last?.hash ?? GENESIS_HASH
  await tx.insert(schema.auditLogs).values({
    at: new Date(entry.at),
    userId: entry.userId,
    sessionId: entry.sessionId,
    channel: entry.channel,
    type: entry.type,
    payloadJson: JSON.stringify(entry.payload),
    prevHash,
    hash: hashEntry(prevHash, entry),
  })
}

export function audit(ctx: AgentContext, type: AuditType, payload: unknown): Promise<void> {
  // Snapshot before queueing: later caller mutations must not rewrite the historical evidence.
  const captured = JSON.parse(JSON.stringify(payload ?? null)), at = Date.now()
  const identity = { userId: ctx.userId, sessionId: ctx.sessionId, channel: ctx.channel }
  const write = tail.then(() => db.transaction((tx) => auditInTransaction(tx, identity, type, captured, at)))
  tail = write.catch(() => {})
  return write
}

export async function verifyAuditLog(): Promise<{ ok: boolean; brokenAt: number }> {
  const rows = await db.select().from(schema.auditLogs).orderBy(asc(schema.auditLogs.seq))
  const entries: StoredAuditEntry[] = rows.map((r) => ({
    at: r.at.getTime(),
    userId: r.userId,
    sessionId: r.sessionId,
    channel: r.channel,
    type: r.type as AuditType,
    payload: JSON.parse(r.payloadJson),
    prevHash: r.prevHash,
    hash: r.hash,
  }))
  const brokenAt = verifyChain(entries)
  return { ok: brokenAt === -1, brokenAt }
}
