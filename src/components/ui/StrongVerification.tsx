import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Fingerprint, ScanFace, MessageSquare, Check } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { StrongStepUp } from '#/server/auth/step-up'

type Request = { purpose: 'action'; actionId: string } | { purpose: 'set_tx_password'; password: string } | { purpose: 'card_password'; requestId: string }
type Method = 'sms' | 'fingerprint' | 'face'
export function useStrongVerification(request: Request, disabled = false, options: { allowSms?: boolean; onMethodSelect?: () => void } = {}) {
  const allowSms = options.allowSms !== false
  const [method, setMethod] = useState<Method>(allowSms ? 'sms' : 'fingerprint'), [code, setCode] = useState('')
  const [challenge, setChallenge] = useState<{ challengeId: string; maskedPhone: string }>()
  const [biometric, setBiometric] = useState<{ method: 'fingerprint' | 'face'; challengeId: string }>()
  const [error, setError] = useState(''), [sending, setSending] = useState(false), [verifying, setVerifying] = useState(false)
  const active = useRef(false), generation = useRef(0), identity = JSON.stringify(request)
  useEffect(() => { generation.current++; setSending(false); setCode(''); setChallenge(undefined); setBiometric(undefined); setError(''); setMethod(allowSms ? 'sms' : 'fingerprint') }, [identity, allowSms])
  const begin = async (method: Method) => {
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
        if (!allowSms || !challenge || !/^\d{6}$/.test(code)) throw new Error('请获取并填写验证码')
        return { method, challengeId: challenge.challengeId, code }
      }
      if (!biometric || biometric.method !== method) throw new Error('请点击指纹或人脸演示验证按钮')
      return biometric
    } finally { active.current = false; setVerifying(false) }
  }
  const controls = <div className="bank-verification-options">
    <div className="bank-verification-methods">{(allowSms ? ['fingerprint', 'face', 'sms'] as const : ['fingerprint', 'face'] as const).map((value) => {
      const Icon = value === 'fingerprint' ? Fingerprint : value === 'face' ? ScanFace : MessageSquare
      return <Button key={value} type="button" disabled={disabled || sending || verifying} aria-pressed={method === value}
        onClick={async () => {
          options.onMethodSelect?.(); setMethod(value); setError(''); setBiometric(undefined)
          if (value === 'sms') return
          const current = ++generation.current; setSending(true)
          try { const data = await begin(value); if (current === generation.current) setBiometric({ method: value, challengeId: data.challengeId }) }
          catch (error) { if (current === generation.current) setError(error instanceof Error ? error.message : '验证失败') }
          finally { if (current === generation.current) setSending(false) }
        }} className={`bank-verification-method${method === value ? ' is-selected' : ''}`}><Icon size={24} /><span>{value === 'fingerprint' ? '指纹验证' : value === 'face' ? '人脸验证' : '短信验证'}</span></Button>
    })}</div>
    {method === 'sms' && <div className="bank-verification-sms">
      <Button type="button" className="bank-payment-secondary w-full" disabled={disabled || sending || verifying} onClick={async () => {
        options.onMethodSelect?.()
        setSending(true); setError('')
        try { setChallenge(await begin('sms')) } catch (error) { setError(error instanceof Error ? error.message : '发送失败') } finally { setSending(false) }
      }}>{sending ? '发送中…' : challenge ? `重新发送至 ${challenge.maskedPhone}` : '获取绑定手机号验证码'}</Button>
      <Input className="bank-auth-input" aria-label="短信验证码" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="请输入 6 位验证码" disabled={disabled || verifying} />
    </div>}
    {method !== 'sms' && <p className={biometric ? 'bank-verification-success' : 'bank-verification-note'}>{biometric && <Check size={15} />}{sending ? '正在演示验证…' : biometric ? '演示验证通过' : '演示模式：点击按钮模拟通过，不进行真实生物识别'}</p>}
    {error && <p className="bank-auth-error" role="alert">{error}</p>}
  </div>
  return { controls, method, getProof, verifying, ready: !sending && !verifying && (method === 'sms' ? allowSms && !!challenge && code.length === 6 : biometric?.method === method) }
}
