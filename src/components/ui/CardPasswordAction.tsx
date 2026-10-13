import { useState } from 'react'
import { Button } from './button'
import { useSecureOperation } from './SecureOperation'
export function CardPasswordAction({ cardId, last4, hasPassword = true }: { cardId: string; last4: string; hasPassword?: boolean }) {
  const open = useSecureOperation(), [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  return <div><Button className="bank-text-button" disabled={busy} onClick={async () => {
    setBusy(true); setMessage('')
    try { const result = await open({ purpose: 'change_card_password', cardId }); if (!result.cancelled) setMessage(result.ok ? `尾号${last4}的密码已单独更新` : result.message ?? '未完成设置') }
    catch (error) { setMessage(error instanceof Error ? error.message : '操作失败') }
    finally { setBusy(false) }
  }}>{busy ? '安全验证中…' : hasPassword ? `修改尾号${last4}密码` : `设置尾号${last4}密码`}</Button>{message && <p className="text-xs demo-muted" role="status">{message}</p>}</div>
}
