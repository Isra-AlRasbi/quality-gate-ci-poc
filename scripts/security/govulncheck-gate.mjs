/**
 * Go vulnerability triage gate (govulncheck).
 *
 * WHY THIS IS A SCRIPT AND NOT A YAML STEP
 * Three properties of govulncheck make "just run it" the wrong answer, and all
 * three were measured in this POC rather than assumed:
 *
 *  1. `-format=json` always exits 0, even when vulnerabilities are found. Text
 *     mode exits 3. So a workflow that runs the JSON format and trusts the exit
 *     code reports GREEN ON A VULNERABLE BUILD. This is the single most dangerous
 *     failure mode in this repository, and it is why the verdict is computed from
 *     the parsed findings and not from the tool's exit status.
 *
 *  2. Findings are not all the same. Most findings are *unreachable*: the module
 *     graph contains a vulnerable package but the program never calls into it.
 *     govulncheck marks those with a trace that has no `function` frame. On this
 *     POC's dependency-free backend the ratio was 243 findings vs 9 reachable.
 *     Blocking on all of them would make the gate unusable.
 *
 *  3. A reachable Go finding is usually in the standard library, and the fix is
 *     "bump the pinned toolchain", not "change this PR". Blocking an unrelated
 *     feature PR on that punishes the wrong developer, so it is a documented,
 *     configurable policy rather than a silent default.
 *
 * Severity is not used for Go: the OSV records govulncheck emits carried
 * `severity: NONE` for every entry observed here, so a CVSS-style threshold
 * would be theatre. Reachability is the honest signal.
 */

import { appendFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { resolve } from 'node:path'

import { decodeJsonStream } from './json-stream.mjs'

/** A finding is reachable only if some trace frame names a called function. */
export function isReachable(finding) {
  const trace = finding?.trace
  if (!Array.isArray(trace) || trace.length === 0) {
    return false
  }
  return trace.some((frame) => typeof frame?.function === 'string' && frame.function.length > 0)
}

/**
 * Module that actually contains the vulnerable symbol.
 *
 * govulncheck orders the trace from the vulnerable symbol towards the program
 * entry point, so the *first* frame carrying a function is the affected symbol
 * and the *last* frame is our own code. Reading the first frame-with-a-function
 * rather than literally frame[0] keeps this correct when govulncheck emits a
 * leading frame that only carries module/version metadata.
 */
export function vulnerableModule(finding) {
  const trace = Array.isArray(finding?.trace) ? finding.trace : []
  const symbolFrame = trace.find((frame) => typeof frame?.function === 'string' && frame.function.length > 0)
  const candidate = symbolFrame ?? trace[0]
  return typeof candidate?.module === 'string' && candidate.module.length > 0 ? candidate.module : 'unknown'
}

/** Buckets a finding so policy can be expressed per bucket. */
export function classify(finding) {
  if (!isReachable(finding)) {
    return 'unreachable'
  }
  return vulnerableModule(finding) === 'stdlib' ? 'stdlib-reachable' : 'third-party-reachable'
}

/**
 * Turns the raw message stream into de-duplicated findings.
 *
 * govulncheck emits one finding per call path, so the same advisory appears many
 * times. Counting paths would exaggerate severity, so findings are grouped by
 * OSV id and the shortest call path is kept as the representative trace.
 */
export function collectFindings(messages) {
  const osvRecords = new Map()
  for (const message of messages) {
    const record = message?.osv
    if (record && typeof record.id === 'string') {
      osvRecords.set(record.id, record)
    }
  }

  const grouped = new Map()
  let malformed = 0

  for (const message of messages) {
    if (!message || typeof message !== 'object') {
      malformed += 1
      continue
    }

    // Known non-finding message kinds in govulncheck's stream. Counting these as
    // "ignored" would bury the cases that actually matter.
    if (!('finding' in message)) {
      continue
    }

    const finding = message.finding
    if (typeof finding?.osv !== 'string') {
      malformed += 1
      continue
    }

    const bucket = classify(finding)
    const existing = grouped.get(finding.osv)

    if (!existing) {
      grouped.set(finding.osv, {
        id: finding.osv,
        fixedVersion: finding.fixed_version ?? null,
        bucket,
        callPaths: 1,
        representativeTrace: summariseTrace(finding.trace),
        aliases: aliasesOf(osvRecords.get(finding.osv)),
      })
      continue
    }

    existing.callPaths += 1
    // Prefer the path that best explains *how we reach it*: shortest wins.
    if ((finding.trace?.length ?? Infinity) < (existing.representativeTrace?.length ?? Infinity)) {
      existing.representativeTrace = summariseTrace(finding.trace)
    }
    // An advisory reachable by several paths must not be downgraded by the last
    // path examined: reachable outranks unreachable.
    if (existing.bucket === 'unreachable' && bucket !== 'unreachable') {
      existing.bucket = bucket
    }
  }

  return { findings: [...grouped.values()], malformed }
}

function aliasesOf(record) {
  const aliases = record?.aliases
  return Array.isArray(aliases) ? aliases.filter((a) => typeof a === 'string') : []
}

function summariseTrace(trace) {
  if (!Array.isArray(trace)) {
    return []
  }
  return trace
    .filter((frame) => typeof frame?.function === 'string')
    .slice(0, 6)
    .map((frame) => `${frame.module === 'stdlib' ? 'stdlib' : frame.module}/${frame.package || '?'}:${frame.function}`)
}

/**
 * Applies .ci/security-policies.env and produces the CI verdict.
 */
export function evaluateGoFindings({ findings, blockThirdParty = true, blockStdlib = false }) {
  const blocking = []
  const advisory = []

  for (const finding of findings) {
    if (finding.bucket === 'unreachable') {
      advisory.push({ ...finding, reason: 'present in the module graph but not called by this program' })
      continue
    }

    const shouldBlock =
      (finding.bucket === 'third-party-reachable' && blockThirdParty) ||
      (finding.bucket === 'stdlib-reachable' && blockStdlib)

    if (shouldBlock) {
      blocking.push(finding)
    } else {
      advisory.push({
        ...finding,
        reason:
          finding.bucket === 'stdlib-reachable'
            ? 'reachable, but the Go standard library is not blocking under the current policy — bump the pinned toolchain'
            : 'reachable third-party finding, not blocking under the current policy',
      })
    }
  }

  return {
    blocked: blocking.length > 0,
    blocking,
    advisory,
    counts: {
      total: findings.length,
      stdlibReachable: findings.filter((f) => f.bucket === 'stdlib-reachable').length,
      thirdPartyReachable: findings.filter((f) => f.bucket === 'third-party-reachable').length,
      unreachable: findings.filter((f) => f.bucket === 'unreachable').length,
      blocking: blocking.length,
      advisory: advisory.length,
    },
    policy: { blockThirdParty, blockStdlib },
  }
}

export function formatResult(result) {
  const lines = [
    `Policy — third-party reachable: ${result.policy.blockThirdParty ? 'BLOCK' : 'report'} | ` +
      `stdlib reachable: ${result.policy.blockStdlib ? 'BLOCK' : 'report'}`,
    `Findings — total ${result.counts.total} | third-party reachable ${result.counts.thirdPartyReachable} | ` +
      `stdlib reachable ${result.counts.stdlibReachable} | unreachable ${result.counts.unreachable}`,
  ]

  if (result.blocking.length > 0) {
    lines.push('', 'BLOCKING findings:')
    for (const f of result.blocking) {
      lines.push(`  ${f.id} [${f.bucket}] fixed in: ${f.fixedVersion ?? 'unknown'}`)
      for (const frame of (f.representativeTrace ?? []).slice(-2)) {
        lines.push(`      via ${frame}`)
      }
    }
  }

  if (result.advisory.length > 0) {
    lines.push('', `Advisory (not blocking): ${result.advisory.length} finding(s)`)
    for (const f of result.advisory.slice(0, 10)) {
      lines.push(`  ${f.id} [${f.bucket}] — ${f.reason}`)
    }
    if (result.advisory.length > 10) {
      lines.push(`  ... ${result.advisory.length - 10} more`)
    }
  }

  return lines.join('\n')
}

export function formatSummaryTable(result) {
  const rows = [
    '### Go vulnerability scan (govulncheck)',
    '',
    '| Bucket | Count | Blocking under current policy |',
    '| --- | --- | --- |',
    `| third-party, reachable | ${result.counts.thirdPartyReachable} | ${result.policy.blockThirdParty ? 'yes' : 'no'} |`,
    `| standard library, reachable | ${result.counts.stdlibReachable} | ${result.policy.blockStdlib ? 'yes' : 'no'} |`,
    `| unreachable (graph only) | ${result.counts.unreachable} | no |`,
    '',
    `**Result: ${result.blocked ? `FAIL — ${result.counts.blocking} blocking finding(s)` : 'PASS'}**`,
  ]

  if (result.blocking.length > 0) {
    rows.push('', '| Advisory | Bucket | Fixed in |', '| --- | --- | --- |')
    for (const f of result.blocking) {
      rows.push(`| \`${f.id}\` | ${f.bucket} | ${f.fixedVersion ?? '?'} |`)
    }
  }

  return rows.join('\n')
}

const BOOL_TRUE = /^(1|true|yes)$/i

async function main() {
  const args = process.argv.slice(2)
  const read = (flag) => {
    const index = args.indexOf(flag)
    return index === -1 || index + 1 >= args.length ? null : args[index + 1]
  }

  const inputPath = read('--input')
  if (!inputPath) {
    console.error('usage: govulncheck-gate.mjs --input <govulncheck-json> [--block-third-party true|false] [--block-stdlib true|false]')
    return 2
  }

  const messages = decodeJsonStream(readFileSync(inputPath, 'utf8'))
  if (messages.length === 0) {
    // An empty stream almost certainly means the scan did not actually run.
    console.error('::error::govulncheck produced no parseable output')
    console.error('Remediation: a scan that produced nothing is not a clean scan. Check the scan step above.')
    return 1
  }

  const { findings, malformed } = collectFindings(messages)
  if (malformed > 0) {
    console.log(`note: ${malformed} finding message(s) carried no usable advisory id and were ignored`)
  }

  const result = evaluateGoFindings({
    findings,
    blockThirdParty: BOOL_TRUE.test(read('--block-third-party') ?? process.env.GATE_GO_BLOCK_REACHABLE_THIRD_PARTY ?? 'true'),
    blockStdlib: BOOL_TRUE.test(read('--block-stdlib') ?? process.env.GATE_GO_BLOCK_ON_STDLIB_FINDINGS ?? 'false'),
  })

  console.log(formatResult(result))

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${formatSummaryTable(result)}\n`)
  }

  if (result.blocked) {
    console.error('::error::Reachable Go vulnerabilities found (see the list above)')
    console.error('Remediation: upgrade the offending dependency, or bump the pinned Go toolchain in .tool-versions.')
    return 1
  }

  if (result.counts.stdlibReachable > 0) {
    console.error(
      `::warning::${result.counts.stdlibReachable} reachable standard-library finding(s); bump Go in .tool-versions (currently non-blocking by policy)`,
    )
  }

  return 0
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`::error::govulncheck gate crashed: ${error.message}`)
      console.error('Remediation: a crashed scan must not be read as a clean one. Fix the scanner, do not skip it.')
      process.exit(1)
    })
}
