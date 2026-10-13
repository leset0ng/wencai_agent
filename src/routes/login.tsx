import { Input } from '#/components/ui/input'
import { Button } from '#/components/ui/button'
import { PhoneInput, resolvePhoneNumber, type PhoneInputValue } from '#/components/ui/phone-input'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { authClient } from '#/lib/auth-client'
import ThemeToggle from '#/components/ThemeToggle'

/** 手机号 + 短信验证码登录（演示环境验证码打在控制台） */
export const Route = createFileRoute('/login')({ component: LoginPage })

type Step = 'phone' | 'code'

function LoginPage() {
  const navigate = useNavigate()
  const { refetch } = authClient.useSession()
  const [step, setStep] = useState<Step>('phone')
  const [phone, setPhone] = useState('')
  const [phoneMeta, setPhoneMeta] = useState<PhoneInputValue>(() => resolvePhoneNumber(''))
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const sendCode = async () => {
    setError('')
    setBusy(true)
    try {
      // 未注册手机号同样发码：服务端配了 signUpOnVerification，验证通过即自动开户
      const res = await authClient.phoneNumber.sendOtp({ phoneNumber: phoneMeta.submissionNumber })
      if (res.error) {
        setError(res.error.message ?? '发送失败')
        return
      }
      setStep('code')
    } finally {
      setBusy(false)
    }
  }

  const verify = async () => {
    setError('')
    setBusy(true)
    try {
      const res = await authClient.phoneNumber.verify({ phoneNumber: phoneMeta.submissionNumber, code }, {
        onError: (ctx) => setError(ctx.error.message),
      })
      if (res?.error) setError(res.error.message ?? '验证失败')
      else {
        // 等会话缓存更新后再进入首页，避免首页用旧的未登录状态跳回登录页。
        await refetch()
        await navigate({ to: '/' })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto flex h-dvh max-w-md flex-col bg-[var(--bg-base)]">
      <header className="flex items-center justify-between border-b border-[var(--line)] px-4 py-3">
        <span className="text-sm font-semibold text-[var(--sea-ink)]">文财 · 登录</span>
        <ThemeToggle />
      </header>
      <div className="flex flex-1 flex-col gap-4 px-4 py-8">
        <div>
          <h1 className="m-0 text-lg font-semibold text-[var(--sea-ink)]">登录文财</h1>
          <p className="mt-1 text-sm demo-muted">登录后才能查询账户、办理业务。身份仅由服务端会话认定。</p>
        </div>

        {step === 'phone' ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              if (!phoneMeta.isValid) {
                setError('请输入所选国家或地区的有效手机号')
                return
              }
              void sendCode()
            }}
          >
            <label className="text-sm text-[var(--sea-ink-soft)]" htmlFor="phone">
              手机号
            </label>
            <PhoneInput
              id="phone"
              className="demo-input"
              placeholder="13800000000"
              value={phone}
              disabled={busy}
              onChange={(value, meta) => { setPhone(value); setPhoneMeta(meta) }}
            />
            <Button className="demo-button" type="submit" disabled={busy}>
              {busy ? '发送中…' : '获取验证码'}
            </Button>
          </form>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              if (!/^\d{6}$/.test(code)) {
                setError('请输入 6 位验证码')
                return
              }
              void verify()
            }}
          >
            <label className="text-sm text-[var(--sea-ink-soft)]" htmlFor="code">
              验证码（已发送至 {phoneMeta.formatted || phone}）
            </label>
            <Input
              id="code"
              className="demo-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="000000"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            />
            <Button className="demo-button" type="submit" disabled={busy}>
              {busy ? '验证中…' : '登录'}
            </Button>
            <Button className="text-sm demo-muted underline" type="button" onClick={() => setStep('phone')}>
              换个手机号
            </Button>
          </form>
        )}

        {error && <p className="m-0 text-sm text-red-600">{error}</p>}
      </div>
    </div>
  )
}
