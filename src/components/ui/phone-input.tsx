import { useState } from 'react'
import type { CountryCode } from 'libphonenumber-js'
import { Input } from './input'
import { SelectControl, SelectOption } from './select'
import { cn } from '#/lib/utils'
import { resolvePhoneNumber, type PhoneInputValue } from '#/lib/phone-number'

export { resolvePhoneNumber, type PhoneInputValue } from '#/lib/phone-number'
export const SUPPORTED_COUNTRIES: { code: CountryCode; name: string; dialCode: string }[] = [
  { code: 'CN', name: '中国', dialCode: '+86' },
  { code: 'HK', name: '中国香港', dialCode: '+852' },
  { code: 'MO', name: '中国澳门', dialCode: '+853' },
  { code: 'TW', name: '中国台湾', dialCode: '+886' },
  { code: 'US', name: '美国', dialCode: '+1' },
  { code: 'CA', name: '加拿大', dialCode: '+1' },
  { code: 'GB', name: '英国', dialCode: '+44' },
  { code: 'JP', name: '日本', dialCode: '+81' },
  { code: 'KR', name: '韩国', dialCode: '+82' },
  { code: 'SG', name: '新加坡', dialCode: '+65' },
  { code: 'AU', name: '澳大利亚', dialCode: '+61' },
  { code: 'DE', name: '德国', dialCode: '+49' },
  { code: 'FR', name: '法国', dialCode: '+33' },
]

export function PhoneInput({ value, onChange, defaultCountry = 'CN', disabled, autoFocus, id = 'phone', placeholder = '输入手机号码', className }: {
  value: string
  onChange: (value: string, meta: PhoneInputValue) => void
  defaultCountry?: CountryCode
  disabled?: boolean
  autoFocus?: boolean
  id?: string
  placeholder?: string
  className?: string
}) {
  const [country, setCountry] = useState<CountryCode>(defaultCountry)
  return <div className={cn('ui-phone-input', className)}>
    <SelectControl aria-label="选择国家或地区国际区号" value={country} disabled={disabled} onValueChange={(next) => {
      setCountry(next as CountryCode)
      const meta = resolvePhoneNumber(value, next as CountryCode)
      onChange(meta.nationalNumber, meta)
    }}>
      {SUPPORTED_COUNTRIES.map((item) => <SelectOption key={item.code} value={item.code}>{item.name} {item.dialCode}</SelectOption>)}
    </SelectControl>
    <Input id={id} type="tel" inputMode="tel" autoComplete="tel" value={value} disabled={disabled} autoFocus={autoFocus}
      placeholder={placeholder} onChange={(event) => {
        const raw = event.target.value
        const meta = resolvePhoneNumber(raw, country)
        if (meta.isValid && (raw.includes('+') || (country === 'CN' && raw.replace(/\D/g, '').length === 13))) {
          setCountry(meta.country)
          onChange(meta.nationalNumber, meta)
        } else onChange(raw, meta)
      }} />
  </div>
}
