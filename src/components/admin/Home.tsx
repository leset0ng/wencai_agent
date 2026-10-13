import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, CircleAlert, Landmark, Loader2, RefreshCw, Search, UsersRound, Wallet } from 'lucide-react'
import { adminApi } from './client'
import { Empty } from './shared'
import { money } from './utils'

export function AdminHome({ onSelect }: { onSelect: (userId: string) => void }) {
  const [search, setSearch] = useState('')
  const query = useQuery({ queryKey: ['admin', 'users'], queryFn: adminApi.users, refetchInterval: 5000 })
  const users = query.data ?? []
  const term = search.trim().toLocaleLowerCase()
  const filtered = users.filter((user) => [user.name, user.phoneNumber ?? '', user.id].some((value) => value.toLocaleLowerCase().includes(term)))

  return (
    <div className="app-shell admin-home">
      <header className="home-header">
        <a className="home-brand" href="/admin">
          <span className="brand-mark"><Landmark size={22} /></span>
          <span>文财银行<small>管理后台</small></span>
        </a>
        <span className="home-environment"><i className="live-dot" />模拟银行服务</span>
      </header>
      <main className="home-content">
        <div className="page-heading">
          <div>
            <span className="eyebrow">银行管理后台</span>
            <h1>选择管理账户</h1>
            <p>查看全部用户，登录指定账户开始管理银行业务。</p>
          </div>
          <Button className="button button-outline" onClick={() => void query.refetch()} disabled={query.isFetching} type="button">
            <RefreshCw size={15} className={query.isFetching ? 'spin' : ''} />刷新用户
          </Button>
        </div>
        <div className="home-summary">
          <div><span className="home-summary-icon"><UsersRound size={20} /></span><span>用户总数<strong>{query.data ? users.length : '—'}<small> 位</small></strong></span></div>
          <div><span className="home-summary-icon"><Landmark size={20} /></span><span>银行账户<strong>{query.data ? users.reduce((sum, user) => sum + user.accountCount, 0) : '—'}<small> 个</small></strong></span></div>
          <div><span className="home-summary-icon"><Wallet size={20} /></span><span>账户总余额<strong>{query.data ? money(users.reduce((sum, user) => sum + user.balanceCents, 0)) : '—'}</strong></span></div>
        </div>
        <section className="panel home-users" aria-label="全部用户">
          <div className="panel-head">
            <div><h2>全部用户</h2><p>每个账户的数据与操作独立展示</p></div>
            <label className="home-search"><Search size={16} /><Input aria-label="搜索用户" placeholder="搜索姓名、手机号或用户 ID" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
          </div>
          {query.isError ? (
            <div className="load-error" role="alert"><CircleAlert size={18} /><div><strong>无法读取用户列表</strong><p>{query.error.message}</p></div><Button className="button button-outline button-sm" onClick={() => void query.refetch()} type="button">重试</Button></div>
          ) : query.isPending ? (
            <div className="loading-workspace"><Loader2 size={28} className="spin" /><strong>正在读取用户列表</strong></div>
          ) : filtered.length === 0 ? (
            <Empty title={term ? '未找到匹配用户' : '暂无用户'} text={term ? '请尝试其他姓名、手机号或用户 ID。' : '用户注册或初始化演示数据后会显示在这里。'} />
          ) : (
            <div className="home-user-grid">
              {filtered.map((user) => (
                <article className="home-user-card" key={user.id}>
                  <div className="home-user-heading">
                    <span className="home-user-avatar">{user.name.slice(0, 1)}</span>
                    <div><h3>{user.name}</h3><p>{user.phoneNumber ?? '未绑定手机号'}</p></div>
                    <span className={`home-user-status${user.locked ? ' is-locked' : ''}`}>{user.locked ? '已锁定' : '正常'}</span>
                  </div>
                  <p className="home-user-id">用户 ID <span>{user.id}</span></p>
                  <div className="home-user-balance"><span>账户总余额</span><strong>{money(user.balanceCents)}</strong></div>
                  <div className="home-user-meta"><span>{user.accountCount} 个银行账户</span><span>风险等级 {user.riskLevel}</span></div>
                  <Button className="button button-primary" aria-label={`登录${user.name}的管理账户`} onClick={() => onSelect(user.id)} type="button">登录账户<ArrowRight size={15} /></Button>
                </article>
              ))}
            </div>
          )}
        </section>
        <footer className="workspace-footer"><span>文财银行管理后台 <i /> 模拟银行服务</span></footer>
      </main>
    </div>
  )
}
