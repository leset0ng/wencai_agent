import { createFileRoute, Navigate } from '@tanstack/react-router'
import { useSession } from '#/lib/auth-client'
import BankingHome from '#/components/banking/BankingHome'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  const { data: session, isPending } = useSession()
  if (isPending && !session) return <div className="bank-session-loading">正在安全连接文财银行…</div>
  if (!session) return <Navigate to="/login" />
  return <BankingHome key={session.user.id} user={session.user} />
}
