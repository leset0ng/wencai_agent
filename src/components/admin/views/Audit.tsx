import { Button } from '#/components/ui/button'
import { FileClock, ChevronDown, ChevronUp } from 'lucide-react'
import { useState } from 'react'
import { Panel, Empty, type ViewProps } from '../shared'
import { dateTime } from '../utils'

export function AdminAudit({ s }: ViewProps) {
  const [expanded, setExpanded] = useState<number | null>(null)

  const logs = s.auditLogs

  return (
    <Panel
      title="操作审计"
      subtitle="每条记录含上一条哈希，可整链校验防篡改"
    >
      {logs.length ? (
        <div className="audit-list">
          {logs.slice(0, 50).map((entry) => (
            <div key={entry.seq} className="audit-item">
              <Button
                type="button"
                className="audit-head"
                aria-expanded={expanded === entry.seq}
                onClick={() => setExpanded(expanded === entry.seq ? null : entry.seq)}
              >
                <span className="audit-type">{entry.type}</span>
                <span className="audit-time">
                  {entry.channel} · {dateTime(entry.at)}
                </span>
                {expanded === entry.seq ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </Button>
              {expanded === entry.seq && (
                <pre className="audit-payload">
                  {JSON.stringify(JSON.parse(entry.payloadJson), null, 2)}
                  {`\n\nhash: ${entry.hash}`}
                </pre>
              )}
            </div>
          ))}
        </div>
      ) : (
        <Empty icon={FileClock} title="暂无审计记录" text="每次业务操作都会在这里留下记录。" />
      )}
    </Panel>
  )
}
