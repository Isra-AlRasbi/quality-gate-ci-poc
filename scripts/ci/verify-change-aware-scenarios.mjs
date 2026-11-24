/**
 * Do representative PR shapes trigger the right jobs?
 *
 * The change-aware gate's failure mode is asymmetric: a filter that matches too much costs a
 * few CI minutes, a filter that matches nothing merges unvalidated code while reporting
 * success. So the interesting question is never "did something run" but "did the RIGHT set
 * run, and did nothing silently run zero jobs".
 *
 * This exercises the actual filter config with the same local matcher as the coverage audit.
 * It does not replace a GitHub PR run.
 *
 * Usage: node scripts/ci/verify-change-aware-scenarios.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { matchesAny } from './lib/glob-match.mjs'
import { parseFilterConfig } from './lib/load-filters.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const file = join(REPO, '.github/ci/paths-filter.yaml')
const filters = parseFilterConfig(readFileSync(file, 'utf8'), file)

/**
 * Which filters SHOULD fire for each shape. Anything absent is unconstrained on purpose: an
 * exhaustive spec would have to be maintained in lockstep with the config, and the point here
 * is to catch a filter that stopped firing, not to freeze incidental ones.
 */
const SCENARIOS = [
  {
    name: 'frontend source only',
    files: ['frontend/src/lib/status.ts', 'frontend/tests/status.test.ts', 'frontend/index.html'],
    expect: { frontend: true, backend: false, shared: false, frontend_docker: true, backend_docker: false, docs: false },
  },
  {
    name: 'backend source only',
    files: ['backend/internal/gate/gate.go', 'backend/cmd/api/main.go'],
    expect: { frontend: false, backend: true, shared: false, frontend_docker: false, backend_docker: true, docs: false },
  },
  {
    name: 'nginx template only',
    files: ['frontend/nginx.conf.template'],
    expect: { frontend: true, frontend_docker: true, backend_docker: false },
  },
  {
    name: 'backend Dockerfile',
    files: ['backend/Dockerfile'],
    expect: { backend: true, backend_docker: true, frontend_docker: false },
  },
  {
    name: 'docs only',
    files: ['README.md', 'docs/releasing.md'],
    expect: { docs: true, frontend: false, backend: false, shared: false, frontend_docker: false, backend_docker: false },
  },
  {
    name: 'ci scripts only',
    files: ['scripts/check-frontend.sh', '.github/workflows/pr-quality-gate.yml'],
    expect: { shared: true, frontend: false, backend: false },
  },
  {
    name: 'toolchain bump',
    files: ['.tool-versions'],
    expect: { shared: true, frontend: false, backend: false, frontend_docker: false, backend_docker: false },
  },
  {
    name: 'backend .dockerignore only',
    files: ['backend/.dockerignore'],
    expect: { backend: true, backend_docker: true, frontend_docker: false },
  },
  // The shapes that motivated all of this. A dotfile-only change is a real PR -- someone
  // tightening npm's registry policy, or narrowing what reaches an image -- and it must not
  // be the shape that runs nothing.
  {
    name: 'frontend .npmrc only',
    files: ['frontend/.npmrc'],
    expect: { frontend: true, frontend_docker: true, backend: false, backend_docker: false, docs: false },
  },
  {
    name: 'frontend .dockerignore only',
    files: ['frontend/.dockerignore'],
    expect: { frontend: true, frontend_docker: true, backend: false },
  },
  // Docker-output changes must not trigger the job that builds the image.
  {
    name: 'build output only',
    files: ['frontend/dist/assets/index.js', 'frontend/coverage/lcov.info', 'backend/bin/api'],
    expect: { frontend_docker: false, backend_docker: false },
    // Nothing sensible runs for these, and that is correct -- so this one shape is allowed to
    // fire no filter, which is exactly why the rule below is a rule and not a blanket.
    allowNoFilter: true,
  },
]

// `docs_only` as pr-quality-gate.yml derives it. Asserted here because the workflow computes
// it from several outputs with a boolean expression, and a filter rename would leave it
// permanently false -- which reads as "not a docs-only change" and costs nothing to notice.
const docsOnly = (files) => {
  const hit = (f) => files.some((file) => matchesAny(file, filters[f] ?? []))
  return hit('docs') && !hit('frontend') && !hit('backend') && !hit('shared')
}

let failed = 0
const say = (ok, msg) => { console.log(`  ${ok ? 'ok ' : 'BAD'} ${msg}`); if (!ok) failed++ }

for (const { name, files, expect, allowNoFilter } of SCENARIOS) {
  const actual = {}
  for (const [filter, patterns] of Object.entries(filters)) {
    actual[filter] = files.some((f) => matchesAny(f, patterns))
  }
  const fired = Object.entries(actual).filter(([, v]) => v).map(([k]) => k)
  console.log(`\n  ${name}: ${files.length === 1 ? files[0] : `${files.length} files`} -> ${fired.length ? fired.join(', ') : '(nothing)'}`)

  for (const [filter, want] of Object.entries(expect)) {
    if (!(filter in actual)) { say(false, `no filter named '${filter}' exists in paths-filter.yaml`); continue }
    say(actual[filter] === want, `${filter}=${want}${actual[filter] !== want ? `, got ${actual[filter]}` : ''}`)
  }

  // A shape that fires nothing is the dangerous outcome, but "nothing" is only wrong when
  // something was expected. allowNoFilter is the honest escape hatch; a scenario silently
  // omitted from the list would be the dishonest one.
  if (fired.length === 0) {
    say(allowNoFilter === true, allowNoFilter
      ? 'fires no filter (declared intentional for this shape)'
      : 'fires no filter -- such a PR would skip every check while the required check goes green')
  }
}

console.log('')
for (const { name, files } of SCENARIOS) {
  const want = name === 'docs only'
  say(docsOnly(files) === want, `docs_only for '${name}' = ${want}`)
}

console.log('')
if (failed) {
  console.error(`${failed} expectation(s) failed`)
  process.exit(1)
}
console.log(`all ${SCENARIOS.length} change-aware shapes classified correctly`)
