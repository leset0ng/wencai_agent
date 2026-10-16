import { useQuery } from '@tanstack/react-query'
import { useCancelAction } from '#/lib/queries'
import ConfirmCard from '#/components/chat/ConfirmCard'
import type { DashboardData } from '#/lib/dashboard'

export function DashboardConfirmation({ item }: { item: NonNullable<DashboardData['pendingTransfers']>[number] }) {
  const cancel = useCancelAction(item.actionId)
  const query = useQuery({ queryKey: ['confirm', item.actionId], queryFn: async () => {
    const response = await fetch(`/api/confirm?actionId=${encodeURIComponent(item.actionId)}`, { credentials: 'same-origin' })
    if (!response.ok) throw new Error('这笔确认单已不可用，请刷新后查看')
    return response.json() as Promise<{ status: string; reasons: string[] }>
  }, retry: false, staleTime: 0 })
  if (query.isPending) return <p className="bank-page-note">正在核对确认单…</p>
  if (query.isError) return <p role="alert" className="bank-error">{query.error.message}</p>
  if (!['pending', 'cancelled', 'expired'].includes(query.data.status)) return <p className="bank-page-note">这笔操作已提交，请在交易明细中核对执行结果。</p>
  const ended = cancel.isSuccess || query.data.status === 'cancelled' ? '已取消操作' : query.data.status === 'expired' ? '确认已超时，请重新发起' : undefined
  return <ConfirmCard {...item} reasons={query.data.reasons} submitting={cancel.isPending} error={cancel.error?.message} onCancel={() => cancel.mutate()} done={ended} doneState={query.data.status === 'expired' ? 'failed' : 'cancelled'} />
}
