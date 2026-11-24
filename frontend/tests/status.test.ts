import { describe, expect, it } from 'vitest'

import {
  checksByStatus,
  formatDuration,
  groupByComponent,
  overallStatus,
  totalDurationSeconds,
  type QualityCheck,
} from '../src/lib/status'

function check(overrides: Partial<QualityCheck> = {}): QualityCheck {
  return {
    id: 'c',
    name: 'check',
    component: 'frontend',
    status: 'success',
    durationSeconds: 10,
    ...overrides,
  }
}

describe('overallStatus', () => {
  it('reports success when every check succeeds', () => {
    expect(overallStatus([check(), check({ id: 'b' })])).toBe('success')
  })

  it('reports failure as soon as one check fails', () => {
    const checks = [check(), check({ id: 'b', status: 'failure' })]
    expect(overallStatus(checks)).toBe('failure')
  })

  it('reports pending rather than success while checks are still running', () => {
    const checks = [check(), check({ id: 'b', status: 'pending' })]
    expect(overallStatus(checks)).toBe('pending')
  })

  it('lets failure win over pending', () => {
    const checks = [check({ status: 'pending' }), check({ id: 'b', status: 'failure' })]
    expect(overallStatus(checks)).toBe('failure')
  })

  it('treats skipped checks as harmless', () => {
    const checks = [check(), check({ id: 'b', status: 'skipped' })]
    expect(overallStatus(checks)).toBe('success')
  })

  it('reports pending for an empty report instead of a misleading success', () => {
    expect(overallStatus([])).toBe('pending')
  })
})

describe('totalDurationSeconds', () => {
  it('sums the duration of checks that actually ran', () => {
    const checks = [
      check({ durationSeconds: 12 }),
      check({ id: 'b', durationSeconds: 8 }),
      check({ id: 'c', status: 'failure', durationSeconds: 5 }),
    ]
    expect(totalDurationSeconds(checks)).toBe(25)
  })

  it('excludes skipped checks so the number means "CI time spent"', () => {
    const checks = [check({ durationSeconds: 12 }), check({ id: 'b', status: 'skipped', durationSeconds: 0 })]
    expect(totalDurationSeconds(checks)).toBe(12)
  })
})

describe('formatDuration', () => {
  it.each([
    [0, '0s'],
    [-3, '0s'],
    [9.4, '9s'],
    [59, '59s'],
    [60, '1m'],
    [90, '1m 30s'],
    [3_600, '1h 0m'],
    [3_725, '1h 2m'],
  ])('formats %s seconds as %s', (input, expected) => {
    expect(formatDuration(input)).toBe(expected)
  })

  it('does not produce NaN for non-finite input', () => {
    expect(formatDuration(Number.NaN)).toBe('0s')
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('0s')
  })
})

describe('groupByComponent', () => {
  const checks = [
    check({ id: 'shared', component: 'shared' }),
    check({ id: 'front', component: 'frontend' }),
    check({ id: 'back', component: 'backend' }),
  ]

  it('returns components in a stable order regardless of input order', () => {
    expect(groupByComponent(checks).map((group) => group.component)).toEqual([
      'frontend',
      'backend',
      'shared',
    ])
  })

  it('omits components with no checks', () => {
    expect(groupByComponent([checks[0]]).map((group) => group.component)).toEqual(['shared'])
  })
})

describe('checksByStatus', () => {
  it('selects only the requested status', () => {
    const checks = [check(), check({ id: 'b', status: 'failure' }), check({ id: 'c', status: 'failure' })]
    expect(checksByStatus(checks, 'failure').map((entry) => entry.id)).toEqual(['b', 'c'])
  })
})
