import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Download, Pause, Play, RefreshCw, ScrollText } from 'lucide-react'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { adminApi } from '../client'
import type { RuntimeLogLevel, RuntimeLogSource } from '#/lib/runtime-logs'

const sources: Record<RuntimeLogSource, string> = { auth: '登录认证', http: '接口请求', agent: 'Agent', system: '系统' }
const levels: Record<RuntimeLogLevel, string> = { info: '信息', warn: '警告', error: '错误' }

export function AdminRuntimeLogs({ back }: { back: () => void }) {
  const [paused, setPaused] = useState(false)
  const [source, setSource] = useState('all')
  const [level, setLevel] = useState('all')
  const [search, setSearch] = useState('')
  const [follow, setFollow] = useState(true)
  const viewport = useRef<HTMLDivElement>(null)
  const query = useQuery({
    queryKey: ['admin', 'runtime-logs'],
    queryFn: adminApi.logs,
    refetchInterval: paused ? false : 2000,
    retry: false,
  })
  const entries = (query.data?.entries ?? []).filter(
    (entry) =>
      (source === 'all' || entry.source === source) &&
      (level === 'all' || entry.level === level) &&
      `${entry.message} ${entry.requestId ?? ''}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  )
  const lastId = entries.at(-1)?.id
  useEffect(() => {
    if (follow && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight
  }, [lastId, follow])

  function download() {
    const text = entries
      .map(
        (entry) =>
          `${entry.at} [${entry.level.toUpperCase()}] [${sources[entry.source]}] ${entry.requestId ? `[${entry.requestId}] ` : ''}${entry.message}`,
      )
      .join('\n')
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `wencai-runtime-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <div className="app-shell admin-home runtime-log-page">
      <header className="home-header">
        <span className="home-brand">
          <ScrollText size={22} />
          文财银行 · 实时日志
        </span>
        <Button className="button button-outline" type="button" onClick={back}>
          <ArrowLeft size={16} />
          返回后台
        </Button>
      </header>
      <main className="home-content">
        <div className="page-heading">
          <div>
            <span className="eyebrow">运行诊断</span>
            <h1>实时日志</h1>
            <p>每 2 秒刷新 · 服务器实际时间 · 最近 {query.data?.capacity ?? 500} 条 · 重启后重新记录</p>
          </div>
          <div className="heading-actions">
            <Button className="button button-outline" type="button" onClick={() => setPaused(!paused)}>
              {paused ? <Play size={16} /> : <Pause size={16} />}
              {paused ? '继续刷新' : '暂停刷新'}
            </Button>
            <Button
              className="button button-outline"
              type="button"
              onClick={() => void query.refetch()}
              disabled={query.isFetching}
            >
              <RefreshCw size={16} />
              刷新
            </Button>
            <Button className="button button-primary" type="button" onClick={download} disabled={!entries.length}>
              <Download size={16} />
              下载当前结果
            </Button>
          </div>
        </div>
        <section className="panel runtime-log-panel" aria-label="运行日志">
          <div className="runtime-log-filters">
            <label>
              来源
              <select aria-label="日志来源" value={source} onChange={(event) => setSource(event.target.value)}>
                <option value="all">全部来源</option>
                {Object.entries(sources).map(([value, name]) => (
                  <option key={value} value={value}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              级别
              <select aria-label="日志级别" value={level} onChange={(event) => setLevel(event.target.value)}>
                <option value="all">全部级别</option>
                {Object.entries(levels).map(([value, name]) => (
                  <option key={value} value={value}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <Input
              aria-label="搜索日志"
              placeholder="搜索内容或请求编号"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <label className="runtime-log-follow">
              <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />
              跟随最新
            </label>
          </div>
          <div className="runtime-log-status" role="status">
            {query.isError ? '连接失败' : paused ? '已暂停自动刷新' : '自动刷新中'} · 当前显示 {entries.length} 条
            {query.dataUpdatedAt > 0 && ` · 最近更新 ${new Date(query.dataUpdatedAt).toLocaleTimeString()}`}
          </div>
          {query.isError && (
            <div className="load-error" role="alert">
              {query.error.message}。请检查后台访问凭据后点击刷新。
            </div>
          )}
          <div
            ref={viewport}
            className="runtime-log-entries"
            role="log"
            aria-label="实时日志内容"
            aria-live="off"
            tabIndex={0}
          >
            {!entries.length && (
              <p className="runtime-log-empty">
                {query.isPending ? '正在读取日志…' : '暂无匹配日志。发起一次登录或接口请求后会显示在这里。'}
              </p>
            )}
            {entries.map((entry) => (
              <div className={`runtime-log-entry is-${entry.level}`} key={`${query.data?.startedAt}-${entry.id}`}>
                <time dateTime={entry.at}>{new Date(entry.at).toLocaleString()}</time>
                <span className="runtime-log-level">{levels[entry.level]}</span>
                <span>{sources[entry.source]}</span>
                <span className="runtime-log-message">
                  {entry.requestId && <b title="同一请求的日志共享此编号">[{entry.requestId}] </b>}
                  {entry.message}
                </span>
              </div>
            ))}
          </div>
        </section>
        <p className="runtime-log-note">
          记录本服务进程的接口结果、登录状态与关键服务错误。密码、验证码、Cookie 和请求正文不进入此日志；开发工具与独立
          worker 的终端输出仍在各自终端查看。
        </p>
      </main>
    </div>
  )
}
