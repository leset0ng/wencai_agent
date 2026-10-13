import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { useEffect, useRef, useState } from 'react'
import type { StrongStepUp } from '#/server/auth/step-up'

type Request = { purpose: 'action'; actionId: string } | { purpose: 'set_tx_password'; password: string }
/** 验证签名与验证码均绑定当前动作；输入变化使已有短信挑战失效。 */
export function useStrongVerification(request: Request, disabled = false) {
  const [method, setMethod] = useState<'passkey' | 'sms'>('passkey')
  const [code, setCode] = useState('')
  const [challenge, setChallenge] = useState<{ challengeId: string; maskedPhone: string }>()
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const active = useRef(false)
  const identity = JSON.stringify(request)
  useEffect(() => { setCode(''); setChallenge(undefined); setError('') }, [identity])
  const begin = async (method: 'passkey' | 'sms') => {
    const res = await fetch('/api/step-up', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...request, method }) })
    const data = await res.json()
    if (!res.ok) throw new Error(data.message ?? '验证失败')
    return data
  }
  const getProof = async (): Promise<StrongStepUp> => {
    if (active.current) throw new Error('正在验证，请稍候')
    active.current = true; setVerifying(true)
    try {
    if (method === 'sms') {
      if (!challenge || !/^\d{6}$/.test(code)) throw new Error('请获取并填写验证码')
      return { method, challengeId: challenge.challengeId, code }
    }
    const { options } = await begin('passkey')
    const { startAuthentication } = await import('@simplewebauthn/browser')
    return { method, response: await startAuthentication({ optionsJSON: options }) }
    } finally { active.current = false; setVerifying(false) }
  }
  const controls = <div className="space-y-2">
    <div className="flex gap-2 text-xs">{(['passkey', 'sms'] as const).map((value) => <Button key={value} type="button" disabled={disabled || sending || verifying} onClick={() => setMethod(value)} className={`bank-lift flex-1 rounded-full border py-2 ${method === value ? 'border-blue-500 text-blue-700' : 'border-slate-200 text-slate-500'}`}>{value === 'passkey' ? 'Passkey 验证' : '短信验证'}</Button>)}</div>
    {method === 'sms' && <div className="space-y-2">
      <Button type="button" className="bank-payment-secondary w-full" disabled={disabled || sending || verifying} onClick={async () => {
        setSending(true); setError('')
        try { setChallenge(await begin('sms')) } catch (e) { setError(e instanceof Error ? e.message : '发送失败') } finally { setSending(false) }
      }}>{sending ? '发送中…' : challenge ? `重新发送至 ${challenge.maskedPhone}` : '获取绑定手机号验证码'}</Button>
      <Input className="demo-input w-full" aria-label="短信验证码" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="请输入 6 位验证码" disabled={disabled || verifying} />
    </div>}
    {error && <p className="text-xs text-red-600" role="alert">{error}</p>}
  </div>
  return { controls, getProof, verifying, ready: !verifying && (method === 'passkey' || (!!challenge && code.length === 6)) }
}
