import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { SecureSheet } from './SecureSheet'
import { notifyConfirmation } from '#/lib/confirmation-notices'
import './bank-security.css'

export type SecureInput = { purpose: 'confirm_action' | 'view_card' | 'change_card_password'; cardId?: string; actionId?: string }
export type SecureResult = { cancelled?: boolean; ok?: boolean; number?: string; message?: string; actionId?: string; userId?: string; output?: unknown; code?: string }
const Context = createContext<((input: SecureInput) => Promise<SecureResult>) | null>(null)
export function useSecureOperation() {
  const open = useContext(Context)
  if (!open) throw new Error('安全页面尚未初始化')
  return open
}
export async function securityPost(body: unknown) {
  const response = await fetch('/api/secure-operation', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data = await response.json()
  if (!response.ok) throw new Error(data.message ?? '安全操作失败')
  return data
}
/** A separate same-origin document owns all secret inputs; callers receive only server results. */
export function SecureOperationProvider({ children }: { children: ReactNode }) {
  const [page, setPage] = useState<{ id: string; url: string }>(), [error, setError] = useState('')
  const [height, setHeight] = useState(328)
  const frame = useRef<HTMLIFrameElement>(null), resolve = useRef<((result: SecureResult) => void) | null>(null)
  const working = useRef(false), pendingFinish = useRef<string | null>(null), qc = useQueryClient()
  const finish = async (id: string) => {
    if (!resolve.current) return
    if (working.current) { pendingFinish.current = id; return }
    working.current = true
    try {
      const result = await securityPost({ action: 'result', id }) as SecureResult
      setPage(undefined); setError('')
      const callback = resolve.current; resolve.current = null
      for (const queryKey of [['dashboard'], ['payments'], ['settings'], ['plans'], ['confirm']]) void qc.invalidateQueries({ queryKey })
      if (result.ok && result.actionId && result.userId) notifyConfirmation({ actionId: result.actionId, userId: result.userId })
      callback(result)
    } catch (error) { setError(error instanceof Error ? error.message : '无法读取结果') }
    finally { working.current = false; const pending = pendingFinish.current; pendingFinish.current = null; if (pending) void finish(pending) }
  }
  const cancel = async (id: string) => {
    if (working.current) return
    working.current = true
    try {
      const result = await securityPost({ action: 'cancel', id })
      if (result.completed) { working.current = false; await finish(id); return }
      setPage(undefined); setError(''); const callback = resolve.current; resolve.current = null; callback?.({ cancelled: true })
    } catch (error) { setError(error instanceof Error ? error.message : '请等待操作完成') }
    finally { working.current = false; const pending = pendingFinish.current; pendingFinish.current = null; if (pending) void finish(pending) }
  }
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (!page || event.origin !== window.location.origin || event.source !== frame.current?.contentWindow || event.data?.requestId !== page.id) return
      if (event.data?.type === 'wencai-secure-complete') void finish(page.id)
      if (event.data?.type === 'wencai-secure-cancel') void cancel(page.id)
      // Only non-secret layout information may cross the document boundary.
      if (event.data?.type === 'wencai-secure-resize' && Number.isFinite(event.data.height)) setHeight(Math.max(160, Math.min(1800, event.data.height)))
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [page])
  useEffect(() => () => { resolve.current?.({ cancelled: true }); resolve.current = null }, [])
  return <Context.Provider value={async (input) => {
    if (resolve.current) throw new Error('请先完成当前安全页面')
    // Reserve before the network request to prevent concurrent opening.
    let callback!: (result: SecureResult) => void
    const promise = new Promise<SecureResult>((done) => { callback = done }); resolve.current = callback
    try { setError(''); setHeight(328); setPage(await securityPost({ action: 'create', ...input })); return promise }
    catch (error) { resolve.current = null; throw error }
  }}>
    {children}
    <SecureSheet open={!!page} height={height} frame={frame} onCancel={() => { if (page) void cancel(page.id) }}>
        {page && <iframe ref={frame} key={page.id} title="银行卡安全验证独立页面" src={page.url} />}
        {error && <p role="alert" className="bank-secure-frame-error">{error}</p>}
    </SecureSheet>
  </Context.Provider>
}
