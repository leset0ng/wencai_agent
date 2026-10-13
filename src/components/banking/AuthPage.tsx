import { useEffect, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { ArrowLeft, ArrowRight, ShieldCheck, Sparkles } from 'lucide-react'
import { authClient } from '#/lib/auth-client'
import { useQueryClient } from '@tanstack/react-query'
import { Input } from '#/components/ui/input'
import { Button } from '#/components/ui/button'
import { PhoneInput, resolvePhoneNumber, type PhoneInputValue } from '#/components/ui/phone-input'
import { Reveal } from '#/components/ui/motion'
import { AgentAvatar } from './AgentAvatar'
import './banking.css'
import '#/components/ui/bank-security.css'

export function AuthPage({ register = false }: { register?: boolean }) {
  const navigate = useNavigate(), queryClient = useQueryClient(), { refetch } = authClient.useSession()
  const [name, setName] = useState(''), [phone, setPhone] = useState('')
  const [meta, setMeta] = useState<PhoneInputValue>(() => resolvePhoneNumber(''))
  const [code, setCode] = useState(''), [sent, setSent] = useState(false), [busy, setBusy] = useState(false)
  const [error, setError] = useState(''), [cooldown, setCooldown] = useState(0)
  useEffect(() => { if (!cooldown) return; const timer = setTimeout(() => setCooldown((value) => value - 1), 1000); return () => clearTimeout(timer) }, [cooldown])
  const send = async () => {
    if (!meta.isValid || (register && !name.trim())) { setError('请填写户名和有效手机号'); return }
    setBusy(true); setError('')
    try {
      const result = await authClient.phoneNumber.sendOtp({ phoneNumber: meta.submissionNumber })
      if (result.error) throw new Error(result.error.message ?? '发送失败')
      setSent(true); setCooldown(60)
    } catch (error) { setError(error instanceof Error ? error.message : '连接失败，请重试') }
    finally { setBusy(false) }
  }
  const verify = async () => {
    setBusy(true); setError('')
    try {
      // Extra registration fields are accepted by the phone plugin and checked by server hooks.
      const result = await fetch('/api/auth/phone-number/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phoneNumber: meta.submissionNumber, code, ...(register ? { registration: true, registrationName: name.trim() } : {}) }) })
      const body = await result.json()
      if (!result.ok) throw new Error(body.message ?? '验证码验证失败')
      queryClient.clear(); await refetch(); await navigate({ to: '/' })
    } catch (error) { setError(error instanceof Error ? error.message : '连接失败，请重试') }
    finally { setBusy(false) }
  }
  return <main className="bank-stage">
    <div className="bank-shell bank-auth-shell">
      <header className="bank-auth-top"><Link to={register ? '/login' : '/'} aria-label="返回"><ArrowLeft size={20} /></Link><span>文财银行</span><ShieldCheck size={20} /></header>
      <Reveal className="bank-auth-hero"><AgentAvatar /><span className="bank-auth-eyebrow">WENCAI · YOUR AI BANK</span><h1>{register ? '开启你的文财账户' : '你好，欢迎回来'}</h1><p>{register ? '用一句话，开启更轻松的金融生活' : '查账、转账、管卡，让文财帮你办'}</p><span className="bank-auth-decoration"><Sparkles size={24} /></span></Reveal>
      <Reveal className="bank-auth-panel" delay={.08}>
        <div className="bank-auth-tabs"><Link to="/login" className={!register ? 'is-active' : ''}>手机登录</Link><Link to="/register" className={register ? 'is-active' : ''}>注册账户</Link></div>
        <form className="bank-security-form" onSubmit={(event) => { event.preventDefault(); void (sent ? verify() : send()) }}>
          {register && <><label htmlFor="register-name">户名</label><Input className="bank-auth-input" id="register-name" autoComplete="name" placeholder="请输入真实户名" maxLength={60} required value={name} disabled={busy || sent} onChange={(event) => setName(event.target.value)} /></>}
          <label htmlFor="auth-phone">手机号</label>
          <PhoneInput id="auth-phone" className="bank-auth-input" value={phone} placeholder="请输入手机号" disabled={busy || sent} onChange={(value, info) => { setPhone(value); setMeta(info) }} />
          {sent && <><label htmlFor="auth-code">短信验证码</label><Input id="auth-code" className="bank-auth-input bank-code-input" inputMode="numeric" autoComplete="one-time-code" placeholder="输入 6 位验证码" maxLength={6} required value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} /><div className="bank-auth-code-actions"><Button type="button" className="bank-text-button" disabled={busy} onClick={() => { setSent(false); setCode(''); setError('') }}>修改{register ? '注册信息' : '手机号'}</Button><Button type="button" className="bank-text-button" disabled={busy || cooldown > 0} onClick={() => void send()}>{cooldown ? `${cooldown}s 后重发` : '重新发送'}</Button></div></>}
          {error && <p role="alert" className="bank-auth-error">{error}</p>}
          <Button className="bank-primary-button bank-auth-submit" type="submit" disabled={busy || !meta.isValid || (register && !name.trim()) || (sent && code.length !== 6)}>{busy ? '正在安全连接…' : sent ? register ? '验证并注册' : '登录' : '获取验证码'}<ArrowRight size={18} /></Button>
        </form>
        <p className="bank-auth-hint"><ShieldCheck size={14} />{register ? '注册后即可使用，申请银行卡时设置该卡密码' : '手机号验证登录 · 交易操作单独保护'}</p>
      </Reveal>
      <footer className="bank-auth-footer">文财 AI 银行 · 模拟银行演示环境</footer>
    </div>
  </main>
}
