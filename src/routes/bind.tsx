import { Button } from '#/components/ui/button'
import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { useMutation } from '@tanstack/react-query'
import { useSession } from '#/lib/auth-client'
import { UnauthorizedError, useBindCode } from '#/lib/queries'
import type { StepUpPayload } from '#/lib/queries'
import ConfirmCard from '#/components/chat/ConfirmCard'
import ThemeToggle from '#/components/ThemeToggle'

export const Route = createFileRoute('/bind')({
  component: BindPage,
  validateSearch: (s: Record<string, unknown>) => ({ code: typeof s.code === 'string' ? s.code : '' }),
})

function BindPage() {
  const { code } = useSearch({ from: '/bind' })
  const { data: session, isPending: sessionPending } = useSession()
  const bindCode = useBindCode(code)
  const navigate = useNavigate()

  return (
    <div className="mx-auto flex h-dvh max-w-md flex-col bg-[var(--bg-base)]">
      <header className="flex items-center justify-between border-b border-[var(--line)] px-4 py-3">
        <span className="text-sm font-semibold text-[var(--sea-ink)]">文财 · 绑定飞书</span>
        <ThemeToggle />
      </header>
      <div className="flex flex-1 flex-col gap-4 px-4 py-6">
        <Body code={code} bindCode={bindCode} sessionPending={sessionPending} hasSession={!!session} navigate={navigate} />
      </div>
    </div>
  )
}

type Nav = ReturnType<typeof useNavigate>

function Body({
  code,
  bindCode,
  sessionPending,
  hasSession,
  navigate,
}: {
  code: string
  bindCode: ReturnType<typeof useBindCode>
  sessionPending: boolean
  hasSession: boolean
  navigate: Nav
}) {
  if (code.length === 0) return <p className="text-sm text-red-600">缺少绑定参数，请在飞书重新获取绑定链接。</p>
  if (sessionPending) return <p className="text-sm demo-muted">加载中…</p>

  if (bindCode.isPending) return <p className="text-sm demo-muted">正在校验绑定链接…</p>

  if (bindCode.error) {
    if (bindCode.error instanceof UnauthorizedError) return <LoginFirst navigate={navigate} />
    return (
      <div className="space-y-2">
        <p className="m-0 text-sm text-red-600">{bindCode.error.message}</p>
        <p className="m-0 text-xs demo-muted">请在飞书重新获取绑定链接。</p>
      </div>
    )
  }

  const info = bindCode.data
  // 服务端说需要登录，但客户端已经判定有会话：让用户重进一次以带上 Cookie
  if (info?.needsLogin && !hasSession) return <LoginFirst navigate={navigate} />

  if (info?.alreadyBoundToOther) {
    return <p className="text-sm text-red-600">该飞书账号已绑定到其他用户，请联系客服处理。</p>
  }

  if (!hasSession) return <LoginFirst navigate={navigate} />
  if (!info) return null

  return (
    <>
      {info.alreadyBoundToMe && <p className="m-0 text-sm demo-muted">当前飞书账号已绑定到你名下。</p>}
      <BindConfirmCard code={code} navigate={navigate} />
    </>
  )
}

function BindConfirmCard({ code, navigate }: { code: string; navigate: Nav }) {
  const bind = useMutation({
    mutationFn: async (stepUp: StepUpPayload) => {
      const res = await fetch('/api/bind', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, stepUp }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || !body.ok) throw new Error(body.message ?? '绑定失败')
    },
  })

  if (bind.isSuccess) {
    return (
      <div className="flex flex-col gap-3">
        <p className="m-0 text-sm text-[var(--sea-ink)]">✅ 绑定成功，现在可以在飞书中使用文财了。</p>
        <Button className="demo-button" type="button" onClick={() => navigate({ to: '/' })}>
          返回首页
        </Button>
      </div>
    )
  }

  return (
    <ConfirmCard
      level="red"
      actionId={`bind:${code}`}
      reasons={['绑定需要完成一次强验证']}
      summary={{
        title: '确认绑定飞书账号',
        fields: [
          { label: '绑定后', value: '可在飞书内办理业务' },
          { label: '限制', value: '红色操作仍需跳转 App 完成强验证' },
        ],
      }}
      error={bind.error?.message}
      onConfirm={(stepUp) => {
        // 红色操作的强验证方式是必填的，缺失说明前端状态异常，直接拒绝
        if (!stepUp) return
        bind.mutate(stepUp)
      }}
    />
  )
}

function LoginFirst({ navigate }: { navigate: Nav }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm demo-muted">请先登录文财，再完成绑定。</p>
      <Button className="demo-button" type="button" onClick={() => navigate({ to: '/login' })}>
        去登录
      </Button>
    </div>
  )
}
