import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { createFileRoute } from '@tanstack/react-router'
import '../components/admin/admin.css'
import { AdminWorkspace } from '../components/admin/Workspace'
import { AdminHome } from '../components/admin/Home'
import type { Section } from '../components/admin/shared'
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

const sections: Section[] = [
  'overview', 'transactions', 'transfers', 'investments',
  'cards', 'subscriptions', 'plans', 'audit',
]

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
  const { section, userId } = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <>
    <div style={{ padding: '8px 20px', textAlign: 'right' }}><Button className="button button-ghost button-sm" onClick={() => setShowAccess(!showAccess)} type="button">后台访问验证</Button>{showAccess && <form style={{ display: 'flex', justifyContent: 'end', gap: 8 }} onSubmit={(e) => { e.preventDefault(); sessionStorage.setItem('wencai_admin_token', token); setToken(''); setShowAccess(false); void qc.invalidateQueries() }}><Input type="password" autoComplete="off" aria-label="后台访问凭据" value={token} onChange={(e) => setToken(e.target.value)} /><Button className="button button-primary" type="submit">验证</Button></form>}</div>
    {!userId ? <AdminHome onSelect={(id) => navigate({ search: { userId: id, section: 'overview' } })} /> :
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
