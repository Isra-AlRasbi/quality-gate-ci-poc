/**
 * Localisation helpers.
 *
 * Only deterministic, locale-table-driven behaviour lives here so the unit
 * tests do not depend on a particular ICU build. Real Arabic/RTL validation is
 * intentionally *not* claimed yet — see docs/extending-the-gate.md.
 */

const RTL_LANGUAGE_PREFIXES = ['ar', 'he', 'fa', 'ur'] as const

/** `ar` -> `rtl`, `en` -> `ltr`. Pure string lookup: no Intl, no flakiness. */
export function directionFor(locale: string): 'rtl' | 'ltr' {
  const language = locale.toLowerCase().split(/[-_]/)[0] ?? ''
  return (RTL_LANGUAGE_PREFIXES as readonly string[]).includes(language) ? 'rtl' : 'ltr'
}

export function isRtl(locale: string): boolean {
  return directionFor(locale) === 'rtl'
}

/**
 * Formats a number for a locale using Latin digits.
 *
 * Latin digits are pinned on purpose: mixed numerals are a real question for
 * Rihal products, but resolving them is a product decision, not a POC concern.
 */
export function formatNumber(value: number, locale = 'en-US'): string {
  return new Intl.NumberFormat(locale, { numberingSystem: 'latn' }).format(value)
}

export interface StatusMessages {
  success: string
  failure: string
  skipped: string
  pending: string
}

/**
 * Message table for the gate banner.
 *
 * `ar` exists to prove the shape of the data is ready for RTL work; it is not a
 * claim that translation coverage or RTL layout has been validated.
 */
export const STATUS_MESSAGES: Record<string, StatusMessages> = {
  en: {
    success: 'All required checks passed',
    failure: 'One or more required checks failed',
    skipped: 'No checks were applicable',
    pending: 'Checks still running',
  },
  ar: {
    success: 'نجحت جميع الفحوصات المطلوبة',
    failure: 'فشل واحد أو أكثر من الفحوصات المطلوبة',
    skipped: 'لا توجد فحوصات مطبقة',
    pending: 'الفحوصات ما زالت قيد التنفيذ',
  },
}

export function statusMessage(status: keyof StatusMessages, locale = 'en'): string {
  const language = locale.toLowerCase().split(/[-_]/)[0] ?? 'en'
  return STATUS_MESSAGES[language]?.[status] ?? STATUS_MESSAGES.en[status]
}
