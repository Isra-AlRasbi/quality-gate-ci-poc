/**
 * Tests for the npm audit triage gate.
 *
 * These matter because this script *is* the security policy. A bug here does not
 * produce a red build, it produces a green build that should have been red.
 *
 * Run: node --test scripts/security/
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  formatResult,
  severityMatcher,
  splitFindings,
  triageAudit,
} from './npm-audit-gate.mjs'

function audit(entries) {
  return {
    vulnerabilities: Object.fromEntries(
      entries.map(([name, severity, extra = {}]) => [
        name,
        {
          name,
          severity,
          isDirect: extra.isDirect ?? true,
          fixAvailable: extra.fixAvailable ?? true,
          range: extra.range ?? '1.0.0',
        },
      ]),
    ),
  }
}

describe('severityMatcher', () => {
  it('blocks the listed severities only', () => {
    const matcher = severityMatcher('critical,high')
    assert.equal(matcher.blocks('critical'), true)
    assert.equal(matcher.blocks('HIGH'), true)
    assert.equal(matcher.blocks('moderate'), false)
    assert.equal(matcher.blocks('low'), false)
  })

  it('blocks nothing when the list is empty', () => {
    for (const input of ['', undefined, null, '   ']) {
      assert.equal(severityMatcher(input).blocks('critical'), false, `input ${input}`)
    }
  })

  it('ignores unknown severity names instead of blocking everything', () => {
    const matcher = severityMatcher('nonsense')
    assert.equal(matcher.label, 'none')
    assert.equal(matcher.blocks('critical'), false)
  })
})

describe('splitFindings', () => {
  it('classifies packages present only in the full graph as dev-only', () => {
    const { production, devOnly } = splitFindings(
      audit([['runtime-pkg', 'high']]),
      audit([
        ['runtime-pkg', 'high'],
        ['build-tool', 'critical'],
      ]),
    )

    assert.deepEqual(
      production.map((f) => f.name),
      ['runtime-pkg'],
    )
    assert.deepEqual(
      devOnly.map((f) => f.name),
      ['build-tool'],
    )
    assert.equal(devOnly[0].scope, 'dev-only')
  })

  it('tolerates missing audit payloads', () => {
    const { production, devOnly } = splitFindings(undefined, undefined)
    assert.deepEqual(production, [])
    assert.deepEqual(devOnly, [])
  })
})

describe('triageAudit', () => {
  it('blocks on a production finding at or above the threshold', () => {
    const result = triageAudit({
      prodReport: audit([['left-pad', 'high']]),
      fullReport: audit([['left-pad', 'high']]),
      prodBlockingCsv: 'critical,high',
      devBlockingCsv: '',
    })

    assert.equal(result.blocked, true)
    assert.equal(result.blocking.length, 1)
    assert.equal(result.blocking[0].name, 'left-pad')
  })

  it('does not block a production finding below the threshold', () => {
    const result = triageAudit({
      prodReport: audit([['quiet-pkg', 'moderate']]),
      fullReport: audit([['quiet-pkg', 'moderate']]),
      prodBlockingCsv: 'critical,high',
      devBlockingCsv: '',
    })

    assert.equal(result.blocked, false)
    assert.equal(result.advisory.length, 1)
  })

  it('does not block dev-only findings when the dev threshold is empty', () => {
    const result = triageAudit({
      prodReport: audit([]),
      fullReport: audit([['eslint', 'critical']]),
      prodBlockingCsv: 'critical,high',
      devBlockingCsv: '',
    })

    assert.equal(result.blocked, false)
    assert.equal(result.advisory.length, 1)
    assert.equal(result.advisory[0].scope, 'dev-only')
  })

  it('blocks dev-only findings once the team raises the dev threshold', () => {
    const result = triageAudit({
      prodReport: audit([]),
      fullReport: audit([['esbuild', 'high']]),
      prodBlockingCsv: 'critical,high',
      devBlockingCsv: 'high',
    })

    assert.equal(result.blocked, true)
    assert.equal(result.blocking[0].rule, 'dev:high')
  })

  it('a clean audit never blocks', () => {
    const result = triageAudit({
      prodReport: audit([]),
      fullReport: audit([]),
      prodBlockingCsv: 'critical,high',
      devBlockingCsv: 'critical,high',
    })

    assert.equal(result.blocked, false)
    assert.deepEqual(result.counts, {
      production: 0,
      devOnly: 0,
      blocking: 0,
      advisory: 0,
    })
  })
})

describe('formatResult', () => {
  it('names the offending package so the log is actionable', () => {
    const result = triageAudit({
      prodReport: audit([['danger', 'critical', { range: '2.0.0' }]]),
      fullReport: audit([['danger', 'critical', { range: '2.0.0' }]]),
      prodBlockingCsv: 'critical,high',
      devBlockingCsv: '',
    })

    const text = formatResult(result)
    assert.match(text, /CRITICAL.*danger/)
    assert.match(text, /fix available: yes/)
  })
})
