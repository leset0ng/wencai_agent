import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, LockKeyhole, ShieldCheck, X } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { CardPasswordInput, CardPasswordKeypad } from '#/components/ui/CardPasswordInput'
import { Button } from '#/components/ui/button'
import { useStrongVerification } from '#/components/ui/StrongVerification'
import '#/components/banking/banking.css'
import '#/components/ui/bank-security.css'
import '#/components/ui/desktop-security.css'

// The independent document is narrower than the desktop window containing it.
const desktopSnapshot = () => window.matchMedia('(min-width: 760px)').matches
const subscribeDesktop = (listener: () => void) => { const media = window.matchMedia('(min-width: 760px)'); media.addEventListener('change', listener); return () => media.removeEventListener('change', listener) }

export const Route = createFileRoute('/secure-operation')({ validateSearch: (s: Record<string, unknown>) => ({ requestId: typeof s.requestId === 'string' ? s.requestId : '' }), component: SecurePage })
interface Info { id: string; purpose: string; status: string; card: { id: string; last4: string; kind: string } | null; actionId: string | null; newPassword: boolean; passwordRequired: boolean; strongRequired: boolean; singleChoice: boolean; dualRequired: boolean; demoBiometrics: boolean; summary: { title: string; fields: { label: string; value: string }[] } | null }
function SecurePage() {
  const desktop = useSyncExternalStore(subscribeDesktop, desktopSnapshot, () => false)
  const { requestId } = Route.useSearch()
  const info = useQuery({ queryKey: ['secure-request', requestId], queryFn: async () => {
    const response = await fetch(`/api/secure-operation?id=${encodeURIComponent(requestId)}`); const data = await response.json(); if (!response.ok) throw new Error(data.message ?? '无法加载安全页面'); return data as Info
  }, retry: false })
  const [password, setPassword] = useState(''), [repeat, setRepeat] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [active, setActive] = useState<'password' | 'repeat' | null>(null), [methodsOpen, setMethodsOpen] = useState(false), [alternative, setAlternative] = useState(false)
  const content = useRef<HTMLElement>(null), reduce = useReducedMotion()
  const strong = !!info.data?.strongRequired
  const useAlternative = !!info.data?.singleChoice && (alternative || !info.data.passwordRequired)
  const needsProof = strong || useAlternative
  const verification = useStrongVerification(info.data?.purpose === 'change_card_password' ? { purpose: 'card_password', requestId } : { purpose: 'action', actionId: info.data?.actionId ?? '' }, busy, { allowSms: !info.data?.dualRequired, presentation: desktop ? 'desktop' : undefined, demoMode: info.data?.demoBiometrics, onMethodSelect: () => { setActive(null); if (info.data?.singleChoice) { setAlternative(true); setPassword('') } } })
  const notify = (type: string) => {
    if (window.parent !== window) window.parent.postMessage({ type, requestId }, window.location.origin)
    else window.location.assign('/settings')
  }
  useEffect(() => { const clear = () => { setPassword(''); setRepeat('') }; window.addEventListener('pagehide', clear); return () => window.removeEventListener('pagehide', clear) }, [])
  useLayoutEffect(() => {
    if (!content.current || window.parent === window) return
    // Report dimensions only, never input values, to size the independent-page sheet.
    const report = () => window.parent.postMessage({ type: 'wencai-secure-resize', requestId, height: Math.ceil(content.current!.getBoundingClientRect().height) }, window.location.origin)
    const observer = new ResizeObserver(report); observer.observe(content.current); report()
    return () => observer.disconnect()
  }, [requestId])
  const data = info.data
  const title = data?.newPassword ? data.purpose === 'change_card_password' ? '设置此卡交易密码' : '为新卡设置交易密码' : '验证身份'
  const cardSuffix = data?.card ? `（尾号 ${data.card.last4}）` : ''
  const amount = data?.summary?.fields.find((field) => field.label === '金额')
  const recipient = data?.summary?.fields.find((field) => /^收款人/.test(field.label))
  const setActiveValue = (update: (value: string) => string) => { if (active === 'password') setPassword(update); if (active === 'repeat') setRepeat(update) }
  const hideKeyboard = () => { setActive(null); (document.activeElement as HTMLElement | null)?.blur() }
  const alternatives = data && !strong && <div className="bank-secure-alternatives"><Button className="bank-text-button bank-secure-method" type="button" aria-expanded={methodsOpen} disabled={busy} onClick={() => { hideKeyboard(); setMethodsOpen(!methodsOpen) }}>使用其他方式验证<ChevronRight size={17} /></Button>
    {(methodsOpen || (data.singleChoice && !data.passwordRequired)) && <div className="bank-secure-mfa">{data.singleChoice ? <>{verification.controls}{useAlternative && data.passwordRequired && <Button className="bank-text-button" onClick={() => { setAlternative(false); setMethodsOpen(false) }}>使用交易密码验证</Button>}</> : <p>查看卡号需验证此卡交易密码。忘记密码可返回安全中心重新设置。</p>}</div>}
  </div>
  return <main ref={content} className={`bank-secure-page${desktop ? ' bank-secure-desktop-page' : ''}`} onKeyDown={(event) => { if (event.key === 'Escape' && !busy) notify('wencai-secure-cancel') }} onFocusCapture={(event) => {
    if (event.target instanceof HTMLInputElement && !['secure-card-password', 'secure-repeat-password'].includes(event.target.id)) setActive(null)
  }}>
    <header>{desktop && <span className="bank-secure-desktop-symbol"><ShieldCheck size={33} /></span>}<div className="bank-secure-title"><h1>{title}</h1>{desktop && <p>{data?.newPassword ? '为银行卡设置独立密码，保护每一笔交易' : strong && data?.passwordRequired ? '输入交易密码，并完成一种身份验证' : '核对本次操作，完成所需安全验证'}</p>}</div>{desktop && data?.demoBiometrics && <span className="bank-secure-demo-badge">演示模式</span>}<Button className="bank-secure-close" aria-label="关闭安全页面" disabled={busy} onClick={() => notify('wencai-secure-cancel')}><X size={21} /></Button></header>
    <div className="bank-secure-page-scroll">
      {info.error && <p role="alert" className="bank-auth-error">{info.error.message}</p>}
      {info.isPending && <div className="bank-secure-loading" role="status" aria-label="正在加载安全信息"><div /><div /><div /><div /></div>}
      {data && <>
        <section className="bank-secure-summary" aria-label="本次操作摘要">
          {amount ? <dl><div className="bank-secure-amount"><dt>{data.summary?.title.includes('转账') ? '本次转账' : data.summary?.title}</dt><dd>{amount.value}</dd></div>{!desktop && recipient && <div><dt>收款人</dt><dd>{recipient.value}</dd></div>}{desktop && data.summary?.fields.filter(field => field !== amount).map((field,index) => <div key={`${field.label}-${index}`}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}</dl>
            : <><h2>{data.summary?.title ?? (data.purpose === 'view_card' ? '查看完整卡号' : '银行卡密码设置')}</h2><p>{data.card ? `${data.card.kind === 'credit' ? '信用卡' : '储蓄卡'} · 尾号 ${data.card.last4}` : '新卡使用独立的 6 位交易密码'}</p></>}
          {data.summary && !desktop && !(amount && recipient) && <details className="bank-secure-details"><summary>查看操作详情</summary><dl>{data.summary.fields.map((field) => <div key={field.label}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}</dl></details>}
          {desktop && data.summary && !amount && <dl className="bank-secure-desktop-details">{data.summary.fields.map((field,index) => <div key={`${field.label}-${index}`}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}</dl>}
          {desktop && <p className="bank-secure-summary-note"><LockKeyhole size={18} />请核对操作信息后继续验证</p>}
        </section>
        <form className="bank-security-form" onSubmit={async (event) => {
          event.preventDefault(); if (busy) return; setError('')
          if (data.newPassword && password !== repeat) { setError('两次输入的密码不一致'); return }
          setBusy(true)
          try {
            const stepUp = needsProof ? await verification.getProof() : undefined
            const submitted = password; setPassword(''); setRepeat(''); hideKeyboard()
            const response = await fetch('/api/secure-operation', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'submit', id: requestId, method: useAlternative ? verification.method : 'password', ...(!useAlternative && (data.newPassword || data.passwordRequired) ? { password: submitted } : {}), stepUp }) })
            const result = await response.json()
            if (!response.ok || !result.ok) { await info.refetch(); throw new Error(result.message ?? '验证失败') }
            notify('wencai-secure-complete')
          } catch (error) { setError(error instanceof Error ? error.message : '连接失败，请重试') }
          finally { setBusy(false) }
        }}>
          <div className="bank-secure-auth-body">
          {desktop && !useAlternative && (data.newPassword || data.passwordRequired) && <h2>交易密码</h2>}
          {!useAlternative && (data.newPassword || data.passwordRequired) && <CardPasswordInput id="secure-card-password" label={data.newPassword ? `请设置${cardSuffix}交易密码` : `请输入${cardSuffix}交易密码`} value={password} onChange={setPassword} onActivate={() => setActive('password')} disabled={busy} isNew={data.newPassword} segmented={desktop} />}
          {data.newPassword && <CardPasswordInput id="secure-repeat-password" label={`请再次输入${cardSuffix}交易密码`} value={repeat} onChange={setRepeat} onActivate={() => setActive('repeat')} disabled={busy} isNew segmented={desktop} />}
          {data.dualRequired && <p className="bank-secure-factor-hint">本次交易需交易密码 + 指纹或人脸验证</p>}
          {strong && !data.dualRequired && data.passwordRequired && <p className="bank-secure-factor-hint">本次操作为红色风险，验证交易密码后还需完成额外验证</p>}
          {strong && <div className="bank-secure-mfa" aria-label="指纹或人脸验证">{desktop && <><h2>身份验证</h2><p>{data.dualRequired ? '指纹或人脸，选择一种方式' : '选择一种可用方式完成验证'}</p></>}{verification.controls}</div>}
          {desktop && alternatives}
          {error && <p role="alert" className="bank-auth-error">{error}</p>}
          </div>
          <div className="bank-secure-actions">{desktop && <p><LockKeyhole size={22} />{data.newPassword ? '密码仅用于银行安全验证' : needsProof && !useAlternative && data.passwordRequired ? data.dualRequired ? '交易密码 + 指纹或人脸验证' : '交易密码 + 身份验证' : useAlternative ? '身份验证' : '银行卡交易密码验证'}</p>}<div>{desktop && <Button className="bank-secure-cancel" disabled={busy} onClick={() => notify('wencai-secure-cancel')}>取消</Button>}
          <Button className="bank-primary-button bank-secure-submit" type="submit" disabled={busy || (!useAlternative && (data.newPassword || data.passwordRequired) && password.length !== 6) || (data.newPassword && repeat.length !== 6) || (needsProof && !verification.ready)}>{busy ? '正在安全处理…' : data.newPassword ? data.purpose === 'change_card_password' ? '确认设置此卡密码' : '设置密码并确认申请' : '确认验证'}</Button>
          </div></div>
          {!desktop && alternatives}
        </form>
      </>}
    </div>
    {active && !desktop && <motion.div initial={reduce ? false : { opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reduce ? 0 : .2 }}>
      <CardPasswordKeypad disabled={busy} onDigit={(digit) => setActiveValue((value) => (value + digit).slice(0, 6))} onDelete={() => setActiveValue((value) => value.slice(0, -1))} onHide={hideKeyboard} />
    </motion.div>}
  </main>
}
