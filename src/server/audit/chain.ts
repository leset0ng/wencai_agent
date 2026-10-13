import { createHash } from 'node:crypto'
import { stableStringify } from '#/server/confirm/integrity'

export const GENESIS_HASH = '0'.repeat(64)

export interface AuditEntry {
  at: number
  userId: string
  sessionId: string
  channel: string
  type: AuditType
  payload: unknown
}

export type AuditType =
  | 'user_input'
  | 'guard_verdict'
  | 'plan_created'
  | 'plan_control'
  | 'tool_call'
  | 'tool_result'
  | 'policy_decision'
  | 'pending_created'
  | 'confirm_attempt'
  | 'action_executed'
  | 'action_compensated'
  | 'injection_redacted'
  | 'output_verification'
  | 'circuit_breaker'
  | 'handoff'
  // 银行管理后台的人工操作
  | 'admin_command'
  // 认证与设备管理
  | 'session_revoked'
  | 'channel_bound'
  | 'channel_unbound'
  | 'bind_rejected'
  | 'tx_password_set'
  | 'passkey_registered'
  | 'passkey_deleted'
  | 'login_failed'
  // 常设授权
  | 'mandate_created'
  | 'mandate_executed'
  | 'mandate_failed'
  | 'mandate_ended'
  | 'mandate_revoked'
  | 'risk_flag_added'
  | 'risk_flag_reviewed'
  | 'risk_analysis_failed'

export function hashEntry(prevHash: string, entry: AuditEntry): string {
  return createHash('sha256').update(prevHash).update(stableStringify(entry)).digest('hex')
}

export interface StoredAuditEntry extends AuditEntry {
  prevHash: string
  hash: string
}

/** 整链校验：返回第一条被篡改记录的下标，-1 表示完整 */
export function verifyChain(entries: StoredAuditEntry[]): number {
  let prev = GENESIS_HASH
  for (let i = 0; i < entries.length; i++) {
    const { prevHash, hash, ...entry } = entries[i]
    if (prevHash !== prev || hashEntry(prev, entry) !== hash) return i
    prev = hash
  }
  return -1
}
