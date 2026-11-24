/**
 * End-to-end test against a REAL govulncheck capture.
 *
 * The unit fixtures in govulncheck-gate.test.mjs encode what we *believe* the
 * tool emits. This test encodes what it *actually* emitted: the file in
 * fixtures/ is a trimmed capture of `govulncheck -format=json` run against this
 * repository's backend with Go 1.25, a version with known reachable
 * standard-library vulnerabilities.
 *
 * If a future govulncheck release changes the wire format, this test fails,
 * which is exactly when we want to find out — not from a green security job.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { collectFindings, evaluateGoFindings } from './govulncheck-gate.mjs'
import { decodeJsonStream } from './json-stream.mjs'

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'govulncheck-vulnerable.json',
)

describe('govulncheck gate against a real capture', () => {
  const messages = decodeJsonStream(readFileSync(FIXTURE, 'utf8'))

  it('parses every message from concatenated pretty-printed output', () => {
    // The capture contains config, osv and finding records.
    assert.ok(messages.length >= 5, `expected several messages, got ${messages.length}`)
    assert.ok(messages.every((m) => m && typeof m === 'object'))
  })

  it('separates reachable from unreachable findings', () => {
    const { findings, malformed } = collectFindings(messages)

    assert.equal(malformed, 0, 'a real capture must not produce malformed findings')
    assert.ok(findings.length > 0, 'the capture is known to contain advisories')

    const buckets = new Set(findings.map((f) => f.bucket))
    assert.ok(buckets.has('unreachable'), 'capture should include an unreachable finding')

    const reachable = findings.filter((f) => f.bucket !== 'unreachable')
    assert.ok(reachable.length > 0, 'the Go 1.25 capture should include reachable findings')
    for (const finding of reachable) {
      assert.ok(finding.id.startsWith('GO-'), `unexpected advisory id ${finding.id}`)
      assert.ok(finding.representativeTrace.length > 0, 'a reachable finding needs an explanatory trace')
    }
  })

  it('does not block when every reachable finding is standard library and stdlib is non-blocking', () => {
    const { findings } = collectFindings(messages)
    const result = evaluateGoFindings({ findings, blockThirdParty: true, blockStdlib: false })

    const thirdPartyReachable = findings.filter((f) => f.bucket === 'third-party-reachable')
    assert.equal(result.blocked, thirdPartyReachable.length > 0)
  })

  it('does block the same capture when stdlib findings are made blocking', () => {
    const { findings } = collectFindings(messages)
    const stdlibReachable = findings.filter((f) => f.bucket === 'stdlib-reachable')

    // Guard the premise: this fixture is only meaningful if it has stdlib hits.
    assert.ok(stdlibReachable.length > 0, 'fixture must contain a reachable stdlib finding')

    const result = evaluateGoFindings({ findings, blockThirdParty: false, blockStdlib: true })
    assert.equal(result.blocked, true)
  })
})
