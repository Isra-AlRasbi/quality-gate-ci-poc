/**
 * Tests for the govulncheck triage gate.
 *
 * The fixtures below mirror the shapes observed from real `govulncheck
 * -format=json` output during this POC: pretty-printed objects concatenated
 * without newlines between them, one finding per call path, and a trace ordered
 * from the vulnerable symbol towards main().
 *
 * Run: node --test scripts/security/
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  classify,
  collectFindings,
  evaluateGoFindings,
  isReachable,
  vulnerableModule,
} from './govulncheck-gate.mjs'
import { decodeJsonStream } from './json-stream.mjs'

const OUR_MODULE = 'github.com/rihal/quality-gate-poc/backend'

function stdlibFrame(pkg, fn) {
  return { module: 'stdlib', version: 'v1.25.14', package: pkg, function: fn }
}

function ourFrame(pkg, fn, file, line) {
  return {
    module: OUR_MODULE,
    package: `${OUR_MODULE}/${pkg}`,
    function: fn,
    position: { filename: file, line },
  }
}

/** Unreachable finding: govulncheck emits a trace with only module metadata. */
function unreachableFinding(osv) {
  return { finding: { osv, fixed_version: 'v1.26.9', trace: [{ module: 'stdlib', version: 'v1.25.14' }] } }
}

function stdlibReachableFinding(osv) {
  return {
    finding: {
      osv,
      fixed_version: 'v1.26.11',
      trace: [stdlibFrame('net/http', 'ListenAndServe'), ourFrame('internal/httpapi', 'Listen', 'internal/httpapi/router.go', 77)],
    },
  }
}

function thirdPartyReachableFinding(osv, module = 'github.com/evil/dep') {
  return {
    finding: {
      osv,
      fixed_version: 'v1.0.1',
      trace: [{ module, version: 'v1.0.0', package: `${module}/bad`, function: 'Do' }, ourFrame('internal/gate', 'Evaluate', 'internal/gate/gate.go', 90)],
    },
  }
}

describe('decodeJsonStream', () => {
  it('parses concatenated pretty-printed objects with no separating newline', () => {
    const text = '{\n  "a": 1\n}{\n  "b": 2\n}'
    assert.deepEqual(decodeJsonStream(text), [{ a: 1 }, { b: 2 }])
  })

  it('parses true newline-delimited JSON too', () => {
    assert.deepEqual(decodeJsonStream('{"a":1}\n{"b":2}\n'), [{ a: 1 }, { b: 2 }])
  })

  it('does not treat braces inside strings as structure', () => {
    const parsed = decodeJsonStream('{"s":"a } b { c"}{"t":1}')
    assert.deepEqual(parsed, [{ s: 'a } b { c' }, { t: 1 }])
  })

  it('handles escaped quotes inside strings', () => {
    assert.deepEqual(decodeJsonStream('{"s":"he said \\"hi\\""}'), [{ s: 'he said "hi"' }])
  })

  it('throws on truncated input rather than silently returning nothing', () => {
    assert.throws(() => decodeJsonStream('{"a": 1'), /truncated JSON/)
  })

  it('throws on garbage between values', () => {
    assert.throws(() => decodeJsonStream('{"a":1} oops {"b":2}'), /unexpected character/)
  })

  it('returns an empty array for whitespace-only input', () => {
    assert.deepEqual(decodeJsonStream('   \n  '), [])
  })
})

describe('isReachable', () => {
  it('is false when no trace frame names a function', () => {
    assert.equal(isReachable(unreachableFinding('GO-1').finding), false)
  })

  it('is true when a trace frame names a function', () => {
    assert.equal(isReachable(stdlibReachableFinding('GO-2').finding), true)
  })

  it('is false for a missing or empty trace', () => {
    assert.equal(isReachable({ osv: 'GO-3' }), false)
    assert.equal(isReachable({ osv: 'GO-3', trace: [] }), false)
  })
})

describe('vulnerableModule', () => {
  it('reports stdlib for a standard-library symbol', () => {
    assert.equal(vulnerableModule(stdlibReachableFinding('GO-2').finding), 'stdlib')
  })

  it('reports the dependency module, not our own module', () => {
    assert.equal(vulnerableModule(thirdPartyReachableFinding('GO-4').finding), 'github.com/evil/dep')
  })

  it('skips a leading metadata-only frame', () => {
    const finding = {
      trace: [{ module: 'stdlib', version: 'v1.25.14' }, stdlibFrame('crypto/x509', 'Verify'), ourFrame('a', 'b', 'c.go', 1)],
    }
    assert.equal(vulnerableModule(finding), 'stdlib')
  })

  it('falls back to unknown instead of throwing', () => {
    assert.equal(vulnerableModule({ trace: [{}] }), 'unknown')
    assert.equal(vulnerableModule(undefined), 'unknown')
  })
})

describe('classify', () => {
  it('separates unreachable, stdlib-reachable and third-party-reachable', () => {
    assert.equal(classify(unreachableFinding('a').finding), 'unreachable')
    assert.equal(classify(stdlibReachableFinding('b').finding), 'stdlib-reachable')
    assert.equal(classify(thirdPartyReachableFinding('c').finding), 'third-party-reachable')
  })
})

describe('collectFindings', () => {
  it('de-duplicates repeated call paths for the same advisory', () => {
    const messages = [stdlibReachableFinding('GO-2').finding, stdlibReachableFinding('GO-2').finding].map(
      (finding) => ({ finding }),
    )
    const { findings } = collectFindings(messages)

    assert.equal(findings.length, 1)
    assert.equal(findings[0].callPaths, 2)
  })

  it('keeps the shortest call path as the explanation', () => {
    const long = {
      finding: {
        osv: 'GO-9',
        trace: [stdlibFrame('a', 'A'), stdlibFrame('b', 'B'), stdlibFrame('c', 'C'), ourFrame('p', 'main', 'm.go', 1)],
      },
    }
    const short = { finding: { osv: 'GO-9', trace: [stdlibFrame('a', 'A'), ourFrame('p', 'main', 'm.go', 1)] } }

    const { findings } = collectFindings([{ finding: long.finding }, { finding: short.finding }])
    assert.equal(findings[0].representativeTrace.length, 2)
  })

  it('never downgrades an advisory to unreachable because of path ordering', () => {
    const messages = [unreachableFinding('GO-5'), stdlibReachableFinding('GO-5')]
    const { findings } = collectFindings(messages)

    assert.equal(findings.length, 1)
    assert.equal(findings[0].bucket, 'stdlib-reachable')
  })

  it('ignores non-finding messages such as config and osv records', () => {
    const messages = [
      { config: { modules: [] } },
      { osv: { id: 'GO-2', aliases: ['CVE-2026-0001'] } },
      stdlibReachableFinding('GO-2'),
    ]
    const { findings, malformed } = collectFindings(messages)

    assert.equal(findings.length, 1)
    assert.equal(malformed, 0)
    assert.deepEqual(findings[0].aliases, ['CVE-2026-0001'])
  })

  it('reports a finding message with no advisory id as malformed', () => {
    const { findings, malformed } = collectFindings([{ finding: { trace: [] } }])

    assert.equal(findings.length, 0)
    assert.equal(malformed, 1)
  })
})

describe('evaluateGoFindings', () => {
  const build = () => [
    unreachableFinding('GO-U'),
    stdlibReachableFinding('GO-S'),
    thirdPartyReachableFinding('GO-T'),
  ].map((message) => collectFindings([message]).findings[0])

  it('blocks reachable third-party findings by default', () => {
    const result = evaluateGoFindings({ findings: build() })

    assert.equal(result.blocked, true)
    assert.deepEqual(
      result.blocking.map((f) => f.id),
      ['GO-T'],
    )
  })

  it('does not block reachable stdlib findings by default', () => {
    const result = evaluateGoFindings({ findings: [collectFindings([stdlibReachableFinding('GO-S')]).findings[0]] })

    assert.equal(result.blocked, false)
    assert.equal(result.counts.stdlibReachable, 1)
    assert.equal(result.advisory[0].reason.includes('toolchain'), true)
  })

  it('blocks stdlib findings when the policy is turned on', () => {
    const result = evaluateGoFindings({
      findings: [collectFindings([stdlibReachableFinding('GO-S')]).findings[0]],
      blockStdlib: true,
    })

    assert.equal(result.blocked, true)
  })

  it('never blocks unreachable findings', () => {
    const result = evaluateGoFindings({
      findings: [collectFindings([unreachableFinding('GO-U')]).findings[0]],
      blockThirdParty: true,
      blockStdlib: true,
    })

    assert.equal(result.blocked, false)
    assert.equal(result.counts.unreachable, 1)
  })

  it('passes a clean scan', () => {
    const result = evaluateGoFindings({ findings: [] })
    assert.equal(result.blocked, false)
    assert.equal(result.counts.total, 0)
  })
})
