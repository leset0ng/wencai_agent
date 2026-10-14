import { Button } from '#/components/ui/button'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { authClient, useSession } from '#/lib/auth-client'
import { usePasskeyDelete, useSecurityAction, useSettings } from '#/lib/queries'
import ThemeToggle, { ThemeSelector } from '#/components/ThemeToggle'
import { ShieldCheck, ArrowLeft } from 'lucide-react'
import { Reveal } from '#/components/ui/motion'
import { CardPasswordAction } from '#/components/ui/CardPasswordAction'
import '#/components/banking/banking.css'
import '#/components/ui/bank-security.css'

export const Route = createFileRoute('/settings')({ component: SettingsPage, validateSearch: (s: Record<string, unknown>) => ({ pwTicket: typeof s.pwTicket === 'string' ? s.pwTicket : '' }) })
function SettingsPage() {
  const { data: session } = useSession(), navigate = useNavigate(), settings = useSettings()
  const action = useSecurityAction(), deletePasskey = usePasskeyDelete(), [error, setError] = useState('')
  const busy = action.isPending || deletePasskey.isPending
  const perform = (body: unknown) => { setError(''); action.mutate(body, { onError: (error) => setError(error.message) }) }
  const [demoResult, setDemoResult] = useState('')
  const data = settings.data
  return <main className="bank-stage"><div className="bank-shell bank-auth-shell bank-settings-shell">
    <header className="bank-auth-top"><a href="/" aria-label="返回银行首页"><ArrowLeft size={20} /></a><span>安全中心</span><ThemeToggle /></header>
    <Reveal className="bank-settings-heading"><span className="bank-security-symbol"><ShieldCheck size={27} /></span><div><h1>守护每一笔安心</h1><p>每卡独立密码 · 安全验证与设备管理</p></div></Reveal>
    <div className="bank-settings-body">
      <section className="bank-appearance-settings"><h2>外观设置</h2><p className="demo-muted text-xs">选择适合你的界面风格，设置会自动保存。</p><ThemeSelector /></section>
      {!session && <p className="demo-muted">请先登录后查看安全设置。</p>}
      {settings.isPending && <p className="demo-muted">加载中…</p>}
      {settings.error && <p className="bank-auth-error" role="alert">{settings.error.message}</p>}
      {data && session && <>
        <section className="space-y-2"><h2>账号</h2><p className="demo-muted text-sm">{data.user.name}</p><Button className="bank-text-button" onClick={async () => { await authClient.signOut(); await navigate({ to: '/login' }) }}>退出登录</Button></section>
        <section className="space-y-3"><h2>银行卡交易密码</h2><p className="demo-muted text-xs">每张卡单独设置密码，申请新卡时完成设置。密码仅在独立安全页面输入。</p>
          {(data.cards ?? []).map((card) => <div className="bank-card-security-row" key={card.id}><span>{card.name}<small>尾号 {card.last4} · {card.hasPassword ? '已设置密码' : '待设置密码'}</small></span><CardPasswordAction cardId={card.id} last4={card.last4} hasPassword={card.hasPassword} /></div>)}
          {!data.cards?.length && <p className="demo-muted text-xs">你还没有银行卡，申请第一张卡时再设置密码即可。</p>}
        </section>
        <section className="space-y-2"><h2>登录设备</h2><p className="demo-muted text-xs">移除其他设备后，那些设备上的会话立即失效。</p>{data.sessions.map((s) => <div className="bank-card-security-row" key={s.id}><span>{s.id === session.session.id ? '当前设备' : s.userAgent ?? '未知设备'}<small>{s.ipAddress ?? '未知 IP'} · 到期 {new Date(s.expiresAt).toLocaleString('zh-CN')}</small></span>{s.id !== session.session.id && <Button className="bank-text-button" disabled={busy} onClick={() => perform({ action: 'revoke_session', sessionId: s.id })}>移除</Button>}</div>)}</section>
        <section className="space-y-2"><h2>渠道绑定</h2><p className="demo-muted text-xs">绑定后可在该渠道办理业务，密码输入与强验证在独立安全页面完成。</p>{!data.bindings.length && <p className="demo-muted text-xs">未绑定任何渠道。</p>}{data.bindings.map((b) => <div className="bank-card-security-row" key={b.id}><span>{b.channel === 'lark' ? '飞书' : b.channel}</span><Button className="bank-text-button" disabled={busy} onClick={() => perform({ action: 'revoke_binding', bindingId: b.id })}>解绑</Button></div>)}</section>
        <section className="space-y-3"><h2>验证方式</h2><p className="demo-muted text-xs">常规交易可选交易密码、短信、指纹或人脸之一。单笔超过 3000 元或收款账户状态异常时，须交易密码加指纹或人脸验证。</p><div className="bank-verification-methods"><Button className="bank-verification-method" onClick={() => setDemoResult('指纹演示验证通过')}>指纹验证（演示）</Button><Button className="bank-verification-method" onClick={() => setDemoResult('人脸演示验证通过')}>人脸验证（演示）</Button></div><p className="demo-muted text-xs">点击模拟通过，不进行真实生物识别。</p>{demoResult && <p role="status" className="bank-verification-success">{demoResult}</p>}{data.passkeys.map((p) => <div className="bank-card-security-row" key={p.id}><span>设备验证凭据{p.backedUp ? '（已同步）' : ''}</span><Button className="bank-text-button" disabled={busy} onClick={() => deletePasskey.mutate(p.id, { onError: (error) => setError(error.message) })}>删除</Button></div>)}</section>
      </>}
      {error && <p role="alert" className="bank-auth-error">{error}</p>}
    </div>
  </div></main>
}
