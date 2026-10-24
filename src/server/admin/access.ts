import { timingSafeEqual } from 'node:crypto'
import { env } from '#/server/env'
import type { AgentContext } from '#/server/agent/context'
import type { TransferInput } from '#/server/payments/service'

/** 演示模式允许免凭据访问；后台总开关仍生效。非演示模式保留原有凭据/本地开发校验。 */
export function adminAuthorized(request: Request) {
  if (!env.ADMIN_ENABLED) return false
  if (env.AUTH_DEMO_MODE) return true
  if (env.ADMIN_TOKEN) {
    const given = Buffer.from(request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '')
    const expected = Buffer.from(env.ADMIN_TOKEN)
    return given.length === expected.length && timingSafeEqual(given, expected)
  }
  const local = (host: string) => ['localhost', '127.0.0.1', '[::1]'].includes(host)
  if (process.env.NODE_ENV === 'production' || !local(new URL(request.url).hostname) || !local(new URL(env.PUBLIC_BASE_URL).hostname)) return false
  const origin = request.headers.get('origin')
  return !origin || origin === new URL(request.url).origin
}

declare const adminTransferBrand: unique symbol
export type AdminTransferGrant = { readonly [adminTransferBrand]: true }
const transferGrants = new WeakMap<object, { userId: string; input: string; expires: number }>()
const transferKey = (input: TransferInput) => JSON.stringify([input.fromAccountId,input.payeeId??null,input.toAccountId??null,input.amountCents,input.memo??null])

/** Server-only, request-authenticated capability: not serializable and not an input flag. */
export function authorizeAdminTransfer(request: Request, userId: string, input: TransferInput): AdminTransferGrant {
  if (!env.ADMIN_ENABLED || !adminAuthorized(request)) throw new Error('后台转账凭据无效')
  const grant = Object.freeze({}) as AdminTransferGrant
  transferGrants.set(grant,{userId,input:transferKey(input),expires:Date.now()+60_000})
  return grant
}

export function consumeAdminTransferGrant(grant: AdminTransferGrant, ctx: AgentContext, input: TransferInput) {
  const record = grant && typeof grant==='object' ? transferGrants.get(grant) : undefined
  if (record) transferGrants.delete(grant)
  if (!env.ADMIN_ENABLED || !record || record.expires<=Date.now() || record.userId!==ctx.userId || ctx.channel!=='web' || ctx.sessionId!=='admin' || record.input!==transferKey(input)) throw new Error('后台转账授权无效、已使用或参数不匹配')
}
