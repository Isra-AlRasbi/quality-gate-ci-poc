#!/usr/bin/env node
/**
 * npm audit triage gate.
 *
 * WHY THIS IS A SCRIPT AND NOT A YAML STEP
 * `npm audit` exits non-zero for *any* finding and offers no way to say "block
 * on production HIGH and above, report dev-only findings without blocking".
 * Piping its exit code straight into CI produces one of two bad outcomes: a
 * permanently red gate that everyone ignores, or a gate that is off. This script
 * makes that policy explicit, and the policy is data (.ci/security-policies.env)
 * rather than shell folklore.
 *
 * HOW IT WORKS
 * It consumes two `npm audit --json` payloads:
 *   --prod-json  -> `npm audit --omit=dev --json`  (what we actually ship)
 *   --full-json  -> `npm audit --json`             (everything, dev included)
 * Anything present in the full graph but not the production graph is
 * dev/build-only, so the two sets are compared instead of guessed at.
 *
 * The triage function is exported and unit tested in npm-audit-gate.test.mjs.
 */

import { appendFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { resolve } from 'node:path'

/** Severity order used for threshold comparisons. `info` is intentionally absent. */
export const SEVERITY_ORDER = ['low', 'moderate', 'high', 'critical']

/**
 * Convert a comma-separated severity list into a matcher.
 * Empty/undefined input means "nothing blocks" — an explicit opt-out, not a bug.
 */
export function severityMatcher(csv) {
  if (!csv || !String(csv).trim()) {
    return { label: 'none', blocks: () => false }
  }
  const allowed = String(csv)
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => SEVERITY_ORDER.includes(entry))

  if (allowed.length === 0) {
    return { label: 'none', blocks: () => false }
  }
  return {
    label: allowed.join('|'),
    blocks: (severity) => allowed.includes(String(severity).toLowerCase()),
  }
}

/**
 * Splits an audit report into production and dev-only findings.
 *
 * npm reports the same top-level package at most once per graph, so comparing
 * by package name is sufficient and avoids walking the dependency tree.
 */
export function splitFindings(prodReport, fullReport) {
  const prodNames = new Set(Object.keys(prodReport?.vulnerabilities ?? {}))

  const production = Object.entries(prodReport?.vulnerabilities ?? {}).map(([name, detail]) => ({
    name,
    severity: detail.severity,
    direct: detail.isDirect === true,
    fixAvailable: detail.fixAvailable !== false,
    range: detail.range ?? '',
    scope: 'production',
  }))

  const devOnly = Object.entries(fullReport?.vulnerabilities ?? {})
    .filter(([name]) => !prodNames.has(name))
    .map(([name, detail]) => ({
      name,
      severity: detail.severity,
      direct: detail.isDirect === true,
      fixAvailable: detail.fixAvailable !== false,
      range: detail.range ?? '',
      scope: 'dev-only',
    }))

  return { production, devOnly }
}

/**
 * Applies the severity policy and decides the CI exit code.
 *
 * Returns { blocking, advisory, blocked, counts } where `blocked` is the single
 * answer CI needs and `blocking`/`advisory` are the rows to print.
 */
export function triageAudit({ prodReport, fullReport, prodBlockingCsv, devBlockingCsv }) {
  const prodMatcher = severityMatcher(prodBlockingCsv)
  const devMatcher = severityMatcher(devBlockingCsv)

  const { production, devOnly } = splitFindings(prodReport, fullReport)

  const blocking = []
  const advisory = []

  for (const finding of production) {
    if (prodMatcher.blocks(finding.severity)) {
      blocking.push({ ...finding, rule: `prod:${prodMatcher.label}` })
    } else {
      advisory.push({ ...finding, rule: `prod:${prodMatcher.label}` })
    }
  }

  for (const finding of devOnly) {
    if (devMatcher.blocks(finding.severity)) {
      blocking.push({ ...finding, rule: `dev:${devMatcher.label}` })
    } else {
      advisory.push({ ...finding, rule: `dev:${devMatcher.label}` })
    }
  }

  return {
    blocked: blocking.length > 0,
    blocking,
    advisory,
    thresholds: { production: prodMatcher.label, devOnly: devMatcher.label },
    counts: {
      production: production.length,
      devOnly: devOnly.length,
      blocking: blocking.length,
      advisory: advisory.length,
    },
  }
}

/** Human-readable failure text. Deliberately names the fix command. */
export function formatResult(result) {
  const lines = []
  lines.push(`Thresholds — production: ${result.thresholds.production} | dev-only: ${result.thresholds.devOnly}`)
  lines.push(
    `Findings — production: ${result.counts.production} | dev-only: ${result.counts.devOnly} | ` +
      `blocking: ${result.counts.blocking} | advisory: ${result.counts.advisory}`,
  )

  if (result.blocking.length > 0) {
    lines.push('')
    lines.push('BLOCKING findings:')
    for (const f of result.blocking) {
      lines.push(
        `  [${f.severity.toUpperCase()}] ${f.name}@${f.range || '?'} (${f.scope}, rule ${f.rule}) ` +
          `— fix available: ${f.fixAvailable ? 'yes' : 'no'}`,
      )
    }
  }

  if (result.advisory.length > 0) {
    lines.push('')
    lines.push('Advisory (not blocking under the current policy):')
    for (const f of result.advisory) {
      lines.push(`  [${f.severity}] ${f.name} (${f.scope})`)
    }
  }

  return lines.join('\n')
}

/** Renders the same information as a GitHub job-summary table. */
export function formatSummaryTable(result) {
  const rows = [
    '### npm dependency audit',
    '',
    '| Scope | Findings | Blocking threshold |',
    '| --- | --- | --- |',
    `| production | ${result.counts.production} | \`${result.thresholds.production}\` |`,
    `| dev-only | ${result.counts.devOnly} | \`${result.thresholds.devOnly}\` |`,
    '',
    `**Result: ${result.blocked ? `FAIL — ${result.counts.blocking} blocking finding(s)` : 'PASS'}**`,
  ]

  if (result.blocking.length > 0) {
    rows.push('', '| Severity | Package | Scope | Fix available |', '| --- | --- | --- | --- |')
    for (const f of result.blocking) {
      rows.push(`| ${f.severity} | \`${f.name}\` | ${f.scope} | ${f.fixAvailable ? 'yes' : 'no'} |`)
    }
  }

  return rows.join('\n')
}

/** CLI entry point. Only runs when executed directly, so tests can import above. */
async function main() {
  const args = process.argv.slice(2)
  const read = (flag) => {
    const index = args.indexOf(flag)
    if (index === -1 || index + 1 >= args.length) {
      return null
    }
    return args[index + 1]
  }

  const prodPath = read('--prod-json')
  const fullPath = read('--full-json')

  if (!prodPath || !fullPath) {
    console.error(
      'usage: npm-audit-gate.mjs --prod-json <file> --full-json <file> ' +
        '[--prod-blocking critical,high] [--dev-blocking <severities>]',
    )
    return 2
  }

  const parse = (file) => {
    const raw = readFileSync(file, 'utf8').trim()
    // npm can print warnings ahead of the JSON on some failures; take the
    // first brace to the end rather than assuming a pristine stdout.
    const start = raw.indexOf('{')
    if (start === -1) {
      throw new Error(`no JSON object found in ${file}`)
    }
    return JSON.parse(raw.slice(start))
  }

  const result = triageAudit({
    prodReport: parse(prodPath),
    fullReport: parse(fullPath),
    prodBlockingCsv: read('--prod-blocking') ?? process.env.GATE_NPM_BLOCKING_SEVERITY_PROD ?? 'critical,high',
    devBlockingCsv: read('--dev-blocking') ?? process.env.GATE_NPM_BLOCKING_SEVERITY_DEV ?? '',
  })

  console.log(formatResult(result))

  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (summaryPath) {
    appendFileSync(summaryPath, `${formatSummaryTable(result)}\n`)
  }

  if (result.blocked) {
    console.error('::error::Dependency audit found blocking vulnerabilities (see list above)')
    console.error('Remediation: upgrade the listed packages, or update the documented policy in .ci/security-policies.env')
    return 1
  }

  return 0
}

// Only run the CLI when this file is executed directly, so tests can import the
// pure functions above without triggering side effects.
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`::error::npm audit gate crashed: ${error.message}`)
      console.error(
        'Remediation: a crashed scan must not be read as a clean one. Fix the script or the audit command.',
      )
      process.exit(1)
    })
}
