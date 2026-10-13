import { Checkbox } from '#/components/ui/checkbox'
import { Input } from '#/components/ui/input'
import { Button } from '#/components/ui/button'
import { SelectControl, SelectOption } from '#/components/ui/select'
import { useState } from 'react'
import { Loader2, ShieldCheck, AlertCircle } from 'lucide-react'
import type { Action } from './actions'
import type { AdminCommand } from './client'
import { AdminApiError } from './client'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '#/components/ui/dialog'

export function ActionDialog({
  action,
  execute,
  onClose,
}: {
  action: Action
  execute: (command: AdminCommand) => Promise<unknown>
  onClose: () => void
}) {
  const [values, setValues] = useState<Record<string, string | string[]>>(() =>
    Object.fromEntries((action.fields ?? []).map((f) => [f.name, f.value ?? (f.type === 'multi' ? [] : '')])),
  )
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const command = action.build(values)
      await execute(command)
      onClose()
    } catch (err) {
      setError(err instanceof AdminApiError ? err.message : err instanceof Error ? err.message : '操作失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  const val = (name: string) => values[name] as string
  const set = (name: string, v: string | string[]) => setValues((x) => ({ ...x, [name]: v }))

  return (
    <Dialog open onOpenChange={(open, details) => { if (busy) details.cancel(); else if (!open) onClose() }} disablePointerDismissal={busy}>
      <DialogContent>
        <div className="dialog-head">
          <DialogTitle>{action.title}</DialogTitle>
          {action.description && <DialogDescription>{action.description}</DialogDescription>}
        </div>
        <form onSubmit={submit}>
          <div className="dialog-fields">
            {action.fields?.map((field) => (
              <label key={field.name} className="field">
                <span>{field.label}</span>
                {field.type === 'select' ? (
                  <SelectControl value={val(field.name)} onValueChange={(value) => set(field.name, value)} required={field.required !== false}>
                    {!field.value && <SelectOption value="">请选择</SelectOption>}
                    {field.options?.map((o) => <SelectOption key={o.value} value={o.value}>{o.label}</SelectOption>)}
                  </SelectControl>
                ) : field.type === 'multi' ? (
                  <div className="multi-options">
                    {field.options?.map((o) => (
                      <label className="check-option" key={o.value}>
                        <Checkbox
                          checked={(values[field.name] as string[]).includes(o.value)}
                          onCheckedChange={(checked) => set(field.name, checked
                              ? [...(values[field.name] as string[]), o.value]
                              : (values[field.name] as string[]).filter((x) => x !== o.value))}
                        />
                        {o.label}
                      </label>
                    ))}
                  </div>
                ) : (
                  <div className={field.type === 'money' ? 'money-input' : ''}>
                    {field.type === 'money' && <b>¥</b>}
                    <Input
                      name={field.name}
                      value={val(field.name)}
                      type={field.type === 'money' ? 'text' : (field.type ?? 'text')}
                      inputMode={field.type === 'money' ? 'decimal' : undefined}
                      min={field.min}
                      max={field.max}
                      required={field.required !== false}
                      onChange={(e) => set(field.name, e.target.value)}
                    />
                  </div>
                )}
                {field.hint && <small>{field.hint}</small>}
              </label>
            ))}
          </div>
          {error && (
            <div className="form-error" role="alert">
              <AlertCircle size={16} />
              <div>{error}</div>
            </div>
          )}
          <div className="dialog-foot">
            <span><ShieldCheck size={15} /> 仅操作模拟账户</span>
            <div>
              <Button type="button" className="button button-ghost" disabled={busy} onClick={onClose}>取消</Button>
              <Button type="submit" className={`button ${action.danger ? 'button-danger' : 'button-primary'}`} disabled={busy}>
                {busy && <Loader2 size={15} className="spin" />}
                {action.submitLabel ?? '确认执行'}
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
