import { env } from '#/server/env'

/** 原确认单的 H5 页面：渠道转交与飞书补验证都跳回同一张确认单。 */
export function confirmLink(actionId: string): string {
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/confirm/${encodeURIComponent(actionId)}`
}
