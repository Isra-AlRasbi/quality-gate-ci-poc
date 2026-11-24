import { describe, expect, it } from 'vitest'

import { directionFor, isRtl, STATUS_MESSAGES, statusMessage } from '../src/lib/i18n'

describe('directionFor', () => {
  it.each([
    ['ar', 'rtl'],
    ['ar-SA', 'rtl'],
    ['ar_EG', 'rtl'],
    ['en', 'ltr'],
    ['en-US', 'ltr'],
    ['fr', 'ltr'],
    ['', 'ltr'],
  ])('maps %s to %s', (locale, expected) => {
    expect(directionFor(locale)).toBe(expected)
  })

  it('is case insensitive', () => {
    expect(directionFor('AR')).toBe('rtl')
  })
})

describe('isRtl', () => {
  it('agrees with directionFor', () => {
    expect(isRtl('ar')).toBe(true)
    expect(isRtl('en')).toBe(false)
  })
})

describe('STATUS_MESSAGES', () => {
  it('keeps every locale covering the same set of statuses', () => {
    const englishKeys = Object.keys(STATUS_MESSAGES.en).sort()
    for (const [locale, messages] of Object.entries(STATUS_MESSAGES)) {
      expect(Object.keys(messages).sort(), `locale ${locale}`).toEqual(englishKeys)
    }
  })
})

describe('statusMessage', () => {
  it('returns English by default', () => {
    expect(statusMessage('failure')).toBe(STATUS_MESSAGES.en.failure)
  })

  it('returns Arabic for the ar locale', () => {
    expect(statusMessage('success', 'ar')).toBe(STATUS_MESSAGES.ar.success)
  })

  it('falls back to English for unknown locales', () => {
    expect(statusMessage('pending', 'de-DE')).toBe(STATUS_MESSAGES.en.pending)
  })
})
