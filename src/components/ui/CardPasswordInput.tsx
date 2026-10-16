import { useState } from 'react'
import { Delete, Eye, EyeOff, Keyboard, LockKeyhole } from 'lucide-react'
import { Input } from './input'
import { Button } from './button'

export function CardPasswordInput({ id, label, value, onChange, onActivate, disabled, isNew = false, segmented = false }: {
  id: string; label: string; value: string; onChange: (value: string) => void; onActivate: () => void; disabled: boolean; isNew?: boolean; segmented?: boolean
}) {
  const [visible, setVisible] = useState(false)
  return <div className="bank-secure-password-field">
    <label htmlFor={id}>{label}</label>
    <div className={`bank-secure-password-control${segmented ? ' is-segmented' : ''}`}>
      <LockKeyhole size={21} aria-hidden="true" />
      {segmented && <div className="bank-secure-password-slots" aria-hidden="true">{Array.from({ length: 6 }, (_, index) => <span key={index} className={index === Math.min(value.length, 5) ? 'is-current' : ''}>{value[index] ? visible ? value[index] : '•' : ''}</span>)}</div>}
      <Input id={id} type={visible ? 'text' : 'password'} inputMode={segmented ? 'numeric' : 'none'} autoComplete={isNew ? 'new-password' : 'off'} maxLength={6}
        value={value} disabled={disabled} placeholder="6 位交易密码" onFocus={onActivate} onClick={onActivate}
        onChange={(event) => onChange(event.target.value.replace(/\D/g, '').slice(0, 6))} />
      <Button animated={false} className="bank-secure-eye" disabled={disabled} aria-label={visible ? '隐藏交易密码' : '显示交易密码'} aria-pressed={visible}
        onPointerDown={(event) => event.preventDefault()} onClick={() => setVisible(!visible)}>{visible ? <Eye size={21} /> : <EyeOff size={21} />}</Button>
    </div>
  </div>
}

/** Reused by both password creation and verification; values stay in the secure document. */
export function CardPasswordKeypad({ onDigit, onDelete, onHide, disabled }: {
  onDigit: (digit: string) => void; onDelete: () => void; onHide: () => void; disabled: boolean
}) {
  return <div className="bank-secure-keypad" role="group" aria-label="交易密码数字键盘">
    {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'hide', '0', 'delete'].map((key) => <Button key={key} animated={false}
      className="bank-secure-key" disabled={disabled} aria-label={key === 'hide' ? '收起数字键盘' : key === 'delete' ? '删除一位密码' : key}
      onPointerDown={(event) => event.preventDefault()} onClick={() => { if (key === 'hide') onHide(); else if (key === 'delete') onDelete(); else onDigit(key) }}>
      {key === 'hide' ? <Keyboard size={25} /> : key === 'delete' ? <Delete size={27} /> : key}
    </Button>)}
  </div>
}
