import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { createFileRoute } from '@tanstack/react-router'
import '../components/admin/admin.css'
import { AdminWorkspace, navigation } from '../components/admin/Workspace'
import { AdminHome } from '../components/admin/Home'
import { AdminRuntimeLogs } from '../components/admin/views/RuntimeLogs'
import type { Section } from '../components/admin/shared'
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

// 从导航配置推导：新增后台页面只改一处，不会出现"导航里有、地址栏打不开"的情况
const sections: Section[] = navigation.map((item) => item.id)

export const Route = createFileRoute('/admin')({
  validateSearch: (search: Record<string, unknown>): { section: Section; userId?: string } => ({
    section: sections.includes(search.section as Section)
      ? (search.section as Section)
      : 'overview',
    userId: typeof search.userId === 'string' && search.userId.trim() ? search.userId.trim() : undefined,
  }),
  component: Admin,
})

function Admin() {
  const [token, setToken] = useState(''), [showAccess, setShowAccess] = useState(false)
  const qc = useQueryClient()
  const access = useQuery({ queryKey: ['admin', 'access-mode'], queryFn: async () => {
    const response = await fetch('/api/admin?action=access', { cache: 'no-store' })
    if (!response.ok) throw new Error('无法读取后台访问模式')
    return (await response.json()) as { data: { demoMode: boolean } }
  }, retry: false })
  const demoMode = access.data?.data.demoMode === true
  const { section, userId } = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <>
    <div style={{ padding: '8px 20px', textAlign: 'right' }}>{demoMode ? <span>演示模式 · 免凭据访问</span> : <><Button className="button button-ghost button-sm" onClick={() => setShowAccess(!showAccess)} type="button">后台访问验证</Button>{showAccess && <form style={{ display: 'flex', justifyContent: 'end', gap: 8 }} onSubmit={(e) => { e.preventDefault(); sessionStorage.setItem('wencai_admin_token', token); setToken(''); setShowAccess(false); void qc.invalidateQueries() }}><Input type="password" autoComplete="off" aria-label="后台访问凭据" value={token} onChange={(e) => setToken(e.target.value)} /><Button className="button button-primary" type="submit">验证</Button></form>}</>}</div>
    {section !== 'logs' && <div className="admin-global-links"><Button className="button button-outline button-sm" type="button" onClick={() => navigate({ search: { userId, section: 'logs' } })}>实时日志</Button></div>}
    {section === 'logs' ? <AdminRuntimeLogs back={() => navigate({ search: { userId, section: 'overview' } })} /> : !userId ? <AdminHome onSelect={(id) => navigate({ search: { userId: id, section: 'overview' } })} /> :
    <AdminWorkspace
      key={userId}
      userId={userId}
      section={section}
      go={(s) => navigate({ search: { userId, section: s } })}
      home={() => navigate({ search: { section: 'overview' } })}
    />}
    </>
  )
}
