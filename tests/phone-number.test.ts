import { describe, expect, it } from 'vitest'
import { resolvePhoneNumber } from '#/lib/phone-number'

describe('merged international phone input', () => {
  it.each(['13800000000', '+86 138 0000 0000', '8613800000000'])('preserves the existing demo identity for %s', (input) => {
    expect(resolvePhoneNumber(input)).toMatchObject({ country: 'CN', isValid: true, submissionNumber: '13800000000' })
  })
  it('submits international numbers in E.164 and detects pasted country codes', () => {
    expect(resolvePhoneNumber('81234567', 'SG')).toMatchObject({ country: 'SG', isValid: true, submissionNumber: '+6581234567' })
    expect(resolvePhoneNumber('+65 8123 4567')).toMatchObject({ country: 'SG', isValid: true, submissionNumber: '+6581234567' })
  })
  it.each(['', '123', 'call me 13800000000'])('rejects incomplete or embedded numbers: %s', (input) => {
    expect(resolvePhoneNumber(input).isValid).toBe(false)
  })
  it('does not treat a mainland-looking value as valid for another selected country', () => {
    expect(resolvePhoneNumber('13800000000', 'SG').isValid).toBe(false)
  })
})
