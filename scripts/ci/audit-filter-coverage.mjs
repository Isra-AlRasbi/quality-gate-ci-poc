// Which tracked files would trigger NO path filter at all?
//
// Why this exists: the change-aware gate is only safe if every file that could affect a
// build, a test or a security decision appears in some filter. A file in no filter means a
// PR touching it runs no validation for it -- and the aggregate check still goes green,
// because "no job failed" and "no job ran" are the same outcome to a status check.
//
// Finding these one at a time is hopeless; there are dozens of files and six filters. So ask
// the question of all of them: for each tracked path, which filters match in our local model?
//
// Usage: node scripts/ci/audit-filter-coverage.mjs [--from <file-list>]
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { matchesAny } from './lib/glob-match.mjs'
import { parseFilterConfig } from './lib/load-filters.mjs'

const REPO = new URL('../..', import.meta.url).pathname

// Files that legitimately trigger no path filter, because an ALWAYS-RUNNING job validates
// them instead. The audit does not take this on trust: each entry names the job, and the
// job is checked to exist in the workflow with no `if:` on it. An exemption whose guarding
// job gained an `if:` would be a hole, and this is the only place that would notice.
const EXEMPT = new Map([
  // Validated by ci-self-check's canary step, which scans with this exact config and fails
  // if it cannot be loaded or produces no report. Also read by security-secrets, which is
  // unconditional for the same reason.
  ['.gitleaks.toml', 'ci-self-check'],
  // The compose file is developer-facing (README: `docker compose up --build`) and no job
  // runs compose, so ci-self-check validates its shape. Before that step existed this file
  // was in no filter and checked by nothing -- a change to a service name or port was
  // invisible to CI while the README kept telling people to run it.
  ['docker-compose.yml', 'ci-self-check'],
  // Read by GitHub when a PR opens, not by any job. Changing it cannot alter a build, a
  // test result or a security verdict.
  ['.github/pull_request_template.md', null],
])

/** Jobs in pr-quality-gate.yml that have no `if:`, i.e. run on every qualifying event. */
function unconditionalJobs(workflowText) {
  const unconditional = new Set()
  let inJobs = false
  let current = null
  for (const line of workflowText.split('\n')) {
    // Only the `jobs:` block has jobs in it. Without this gate, the two-space-indented event
    // keys under `on:` (pull_request, workflow_dispatch) would be collected as jobs, and an
    // exemption naming a typo would be "verified" against one of them.
    if (/^jobs:\s*$/.test(line)) { inJobs = true; continue }
    if (!inJobs) continue
    if (/^[A-Za-z0-9_-]+:/.test(line)) break // next top-level key: the jobs block is over
    const job = line.match(/^  ([A-Za-z0-9_-]+):\s*$/)
    if (job) { current = job[1]; unconditional.add(current); continue }
    // Job-level `if:` is at exactly 4 spaces. Step-level `if:` is at 8 and must not count:
    // a conditional step does not make the job conditional.
    if (current && /^ {4}if:/.test(line)) unconditional.delete(current)
  }
  return unconditional
}

let filters
try {
  const file = `${REPO}.github/ci/paths-filter.yaml`
  filters = parseFilterConfig(readFileSync(file, 'utf8'), file)
} catch (e) { console.error(e.message); process.exit(2) }

// Enumerate tracked files. Staged-and-committed files are `git ls-files -c`; a repository
// with no commits yet has an empty index, so untracked-but-not-ignored files are included
// too. Without that, this audit reports "0 files audited" and passes on an empty set, which
// is the exact false green this repository documents everywhere else: an empty input must
// never read as success.
const tracked = (() => {
  const git = (args) => execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8' })
    .split('\n').filter(Boolean)
  return [...new Set([...git(['ls-files', '-c']), ...git(['ls-files', '-o', '--exclude-standard'])])].sort()
})()

const files = process.argv.includes('--from')
  ? readFileSync(process.argv[process.argv.indexOf('--from') + 1], 'utf8').split('\n').filter(Boolean)
  : tracked

if (files.length === 0) {
  console.error('refusing to audit an empty file list: nothing audited is not everything audited')
  process.exit(1)
}

const rows = []
for (const file of files) {
  const hit = Object.entries(filters)
    .filter(([, pats]) => matchesAny(file, pats))
    .map(([k]) => k)
  if (hit.length === 0 && !EXEMPT.has(file)) rows.push(file)
}

// `docs_only` is derived in the workflow, so `docs` being the only hit is meaningful:
// report it separately, it is not a hole but it is worth seeing.
const docsOnly = files.filter((f) => {
  const hit = Object.entries(filters)
    .filter(([, pats]) => matchesAny(f, pats))
    .map(([k]) => k)
  return hit.length === 1 && hit[0] === 'docs' && !EXEMPT.has(f)
})

console.log(`filters: ${Object.keys(filters).join(', ')}`)
console.log(`tracked files audited: ${files.length}`)
console.log(`\n=== files matched by NO filter (${rows.length}) ===`)
for (const r of rows) console.log(`  ${r}`)
if (!rows.length) console.log('  none')

// An exemption is only safe while the job that covers it is unconditional. Verify that, so
// the list cannot rot into "we think something checks this".
const workflowPath = `${REPO}.github/workflows/pr-quality-gate.yml`
const unconditional = unconditionalJobs(readFileSync(workflowPath, 'utf8'))
const brokenExemptions = []
for (const [file, job] of EXEMPT) {
  if (!job) continue
  if (!files.includes(file)) { brokenExemptions.push(`${file}: exempted but not present in the repository`); continue }
  if (!unconditional.has(job)) {
    brokenExemptions.push(`${file}: exempted on the assumption '${job}' always runs, but that job is missing or has an 'if:'`)
  }
}
console.log(`\n=== exemptions from path filtering, and whether their guard still holds (${EXEMPT.size}) ===`)
for (const [file, job] of EXEMPT) {
  if (!files.includes(file)) continue
  const ok = !job || unconditional.has(job)
  console.log(`  ${ok ? 'ok ' : 'BAD'} ${file.padEnd(34)} ${job ? `guarded by always-running '${job}'` : 'no job needs to run it'}`)
}
for (const b of brokenExemptions) console.log(`  BAD ${b}`)

console.log(`\n=== documentation-only paths (${docsOnly.length}) ===`)
for (const d of docsOnly) console.log(`  ${d}`)
process.exit(rows.length || brokenExemptions.length ? 1 : 0)
