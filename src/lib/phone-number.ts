import { getCountryCallingCode, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max'

export interface PhoneInputValue {
  nationalNumber: string
  e164: string
  country: CountryCode
  isValid: boolean
  formatted: string
  /** Existing mainland demo accounts use eleven digits; other numbers use E.164. */
  submissionNumber: string
}

export function resolvePhoneNumber(input: string, defaultCountry: CountryCode = 'CN'): PhoneInputValue {
  let raw = input.trim()
  const digits = raw.replace(/\D/g, '')
  if (defaultCountry === 'CN' && /^[\d\s()-]+$/.test(raw) && digits.startsWith('86') && digits.length === 13) raw = `+${digits}`
  const parsed = parsePhoneNumberFromString(raw, { defaultCountry, extract: false })
  if (parsed) {
    const country = parsed.country ?? defaultCountry
    return {
      nationalNumber: parsed.nationalNumber,
      e164: parsed.number,
      country,
      isValid: parsed.isValid(),
      formatted: parsed.formatInternational(),
      submissionNumber: country === 'CN' ? parsed.nationalNumber : parsed.number,
    }
  }
  return {
    nationalNumber: digits,
    e164: digits ? `+${getCountryCallingCode(defaultCountry)}${digits}` : '',
    country: defaultCountry,
    isValid: false,
    formatted: raw,
    submissionNumber: defaultCountry === 'CN' ? digits : '',
  }
}
