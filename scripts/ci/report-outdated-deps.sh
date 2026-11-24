#!/usr/bin/env bash
# Report dependencies behind their pinned version. Informational only.
#
# WHY THIS IS NOT BLOCKING
# A dependency three majors behind is real technical debt, but every individual
# version bump is a judgement call with its own breaking changes. Making CI red over
# "vitest 3 -> 4 exists" produces a permanently-red signal that people learn to
# ignore, which degrades every *real* check next to it. So this reports, and a human
# decides. The line where an advisory becomes blocking is covered in
# docs/extending-the-gate.md.
set -uo pipefail
# shellcheck source=scripts/lib/gate-bootstrap.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/gate-bootstrap.sh"

gate_step "Scheduled · Outdated frontend dependencies (informational)"

cd "$ROOT/frontend" || exit 1

if [[ ! -d node_modules ]]; then
  gate_warn "node_modules is absent; 'npm outdated' needs an installed tree. Skipping."
  exit 0
fi

gate_group "npm outdated"
RAW="$(npm outdated --json 2>/dev/null || true)"
gate_endgroup

# npm exits non-zero when anything is outdated and prints nothing for a fully
# current tree, so an empty string means "up to date", not "the command failed".
if [[ -z "${RAW//[[:space:]]/}" || "${RAW//[[:space:]]/}" == "{}" ]]; then
  gate_ok "No outdated dependencies"
  gate_append_summary "" "Outdated frontend dependencies: **none**"
  exit 0
fi

node -e '
const raw = process.argv[1]
let data = {}
try {
  data = JSON.parse(raw)
} catch (error) {
  console.error(`could not parse "npm outdated --json": ${error.message}`)
  // Deliberately not a failure: this step is informational. A parse failure prints
  // the raw output so a human can read it rather than reporting a clean tree.
  console.log("unparsed output:")
  console.log(raw)
  process.exit(0)
}

const names = Object.keys(data)
if (names.length === 0) {
  console.log("none")
  process.exit(0)
}

// Out of date against the range in package.json ("wanted") is more actionable than
// merely trailing the newest release, so those are listed first.
const behindWanted = names.filter((n) => data[n].current !== data[n].wanted)
const behindLatestOnly = names.filter((n) => data[n].current === data[n].wanted)

if (behindWanted.length > 0) {
  console.log(`Behind the version range declared in package.json (${behindWanted.length}):`)
  for (const name of behindWanted) {
    const p = data[name]
    console.log(`  ${name}: ${p.current} -> ${p.wanted} (latest ${p.latest})`)
  }
}
if (behindLatestOnly.length > 0) {
  console.log(`Satisfied as declared, but a newer release exists (${behindLatestOnly.length}):`)
  for (const name of behindLatestOnly) {
    const p = data[name]
    console.log(`  ${name}: ${p.current} (latest ${p.latest})`)
  }
}
' "$RAW"

gate_append_summary \
  "" \
  "### Outdated frontend dependencies (informational)" \
  "" \
  '```text' \
  "$(node -e '
    const data = JSON.parse(process.argv[1] || "{}")
    const names = Object.keys(data)
    if (names.length === 0) { console.log("none"); }
    for (const n of names) console.log(`${n}: ${data[n].current} -> wanted ${data[n].wanted} (latest ${data[n].latest})`)
  ' "$RAW")" \
  '```'

gate_log "informational only — this never fails the build"
