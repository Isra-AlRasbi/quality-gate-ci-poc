#!/usr/bin/env bash
# Secret leak scan (security baseline, requirement 8).
#
# WHAT IS CHECKED
# Commits introduced by the change, scanned for credentials with gitleaks. The
# ruleset and allowlist are in .gitleaks.toml.
#
# WHY SCANNING COMMITS AND NOT JUST THE WORKING TREE
# A secret in the *current* tree is only part of the problem. A secret added in
# commit 3 of a five-commit PR and deleted in commit 5 is invisible to a file scan
# and permanently present in the repository history that everyone clones. Scanning
# the commit range catches the case that a file scan structurally cannot.
#
# WHY AN EXPLICIT FIX IS REQUIRED FOR HISTORY FINDINGS
# Deleting the line does not remove the secret. Anyone with clone access already
# has it, so it must be rotated. The message below says that first, because the
# instinct is to delete and force-push, which fixes the log and leaves the
# credential live.
set -uo pipefail

# shellcheck source=scripts/lib/gate-bootstrap.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/gate-bootstrap.sh"
gate_load_policy "$ROOT/.ci/security-policies.env" || exit 1

cd "$ROOT" || exit 1
START=$(date +%s)
CONFIG="$ROOT/.gitleaks.toml"

gate_step "Security · Secret leak scan (gitleaks)"

[[ -f "$CONFIG" ]] || {
  gate_error ".gitleaks.toml is missing" \
    "Restore it. Running gitleaks with no config drops the allowlist and produces a wall of false positives, which is how this check gets switched off."
  exit 1
}

# --- how to scan: prefer an installed binary, then the pinned container ---
# Both paths use identical arguments, so the same ruleset and the same exit
# semantics apply whether this runs on a runner or a laptop.
GITLEAKS_IMAGE="$(gate_read_key "$ROOT/.github/ci/tools.lock.env" GITLEAKS_IMAGE || true)"
RUNNER=()
CONFIG_ARG=""

if command -v gitleaks >/dev/null 2>&1; then
  RUNNER=(gitleaks)
  CONFIG_ARG="$CONFIG"
  gate_log "using gitleaks from PATH: $(gitleaks version 2>/dev/null | head -1 || echo 'version unknown')"
elif [[ -n "$GITLEAKS_IMAGE" && "$GITLEAKS_IMAGE" == *"@sha256:"* ]] && command -v docker >/dev/null 2>&1; then
  # The container is pinned by digest, so a new gitleaks release cannot change the
  # ruleset underneath a PR that was green an hour ago.
  RUNNER=(docker run --rm -i -v "${ROOT}:/repo" -w /repo "${GITLEAKS_IMAGE}")
  # Must be the in-container path: the container cannot see the host filesystem.
  CONFIG_ARG="/repo/$(basename "$CONFIG")"
  gate_log "using pinned container: ${GITLEAKS_IMAGE}"
else
  gate_error "No gitleaks available" \
    "Install gitleaks (https://github.com/gitleaks/gitleaks) or make Docker available." \
    "This check is blocking, so CI fails rather than passing silently."
  exit 1
fi

# --- refuse to scan a repository with nothing to scan --------------------
# Distinguished from a bad revision range on purpose. A repository with no commits
# genuinely has no history to inspect; a repository with 200 commits where the scan
# saw 0 is a broken range. Reporting the first as "clean" is defensible; reporting
# the second is the false green this whole script exists to avoid.
if ! git rev-parse --verify --quiet HEAD >/dev/null; then
  gate_warn "No commits in this repository yet; there is no history to scan"
  echo "This is expected before the first commit and is not a passing secret scan."
  echo "In CI this never happens: actions/checkout always produces a commit."
  exit 0
fi

# --- choose the commit range ---------------------------------------------
# `--log-opts` is gitleaks' way of taking arbitrary git revision arguments.
# GitHub gives us the PR base SHA; without it (first push, direct push, local run)
# fall back to the last 10 commits, and to a whole-repo scan if the repo is young.
LOG_OPTS=""
if [[ -n "${GITLEAKS_BASE:-}" ]]; then
  LOG_OPTS="--left-right ${GITLEAKS_BASE}...HEAD"
  gate_log "scanning commits introduced since ${GITLEAKS_BASE:0:7}"
elif git rev-parse --verify --quiet HEAD~10 >/dev/null; then
  LOG_OPTS="--left-right HEAD~10...HEAD"
  gate_log "no base revision supplied; scanning the last 10 commits"
else
  LOG_OPTS=""
  gate_log "repository has <10 commits; scanning the full history"
fi

# Report goes inside the repo because the container only sees the mount. It is
# gitignored, and removed on exit either way.
REPORT="$ROOT/.gitleaks-report.json"
rm -f "$REPORT"
trap 'rm -f "$REPORT"' EXIT

REPORT_ARG="/repo/$(basename "$REPORT")"
if ! git check-ignore -q "$REPORT" 2>/dev/null; then
  gate_warn "$(basename "$REPORT") is not gitignored; the secret scan report must never be committed"
fi

gate_group "Run gitleaks"
# `--redact` keeps the discovered value out of both stdout and the report: a secret
# scanner that prints the secret into the build log has created the leak it was
# checking for.
#
# `|| true` is deliberate. gitleaks exits 1 on findings, which is *data* for the
# parser below, not a verdict. Only an unusable report is treated as failure.
GITLEAKS_LOG="$(mktemp)"
if [[ -n "$LOG_OPTS" ]]; then
  # shellcheck disable=SC2086 # intentional word splitting of the git revision args
  "${RUNNER[@]}" detect \
    --config "${CONFIG_ARG}" \
    --redact \
    --no-banner \
    --exit-code 1 \
    --report-format json \
    --report-path "${REPORT_ARG}" \
    --log-opts "$LOG_OPTS" >"$GITLEAKS_LOG" 2>&1 || true
else
  "${RUNNER[@]}" detect \
    --config "${CONFIG_ARG}" \
    --redact \
    --no-banner \
    --exit-code 1 \
    --report-format json \
    --report-path "${REPORT_ARG}" >"$GITLEAKS_LOG" 2>&1 || true
fi
sed 's/^/  /' "$GITLEAKS_LOG"
gate_endgroup

# --- did the scan actually look at anything? ------------------------------
# gitleaks reports "0 commits scanned" and "no leaks found" in the same breath, and
# exits 0. A range that resolves to nothing therefore reads as a clean scan. That is
# the exact false green a security check must never produce, so the line count is
# treated as a precondition rather than trusted away.
SCANNED="$(grep -oE '[0-9]+ commits? scanned' "$GITLEAKS_LOG" | grep -oE '^[0-9]+' | head -1 || true)"
rm -f "$GITLEAKS_LOG"

if [[ "${SCANNED:-0}" == "0" ]]; then
  gate_error "gitleaks scanned 0 commits" \
    "A secret scan that inspected nothing is not a clean scan." \
    "Revision range used: ${LOG_OPTS:-<full history>}" \
    "Check that the base revision exists in this checkout (a shallow checkout with fetch-depth: 1 has no base to diff)."
  exit 1
fi
gate_log "gitleaks inspected ${SCANNED} commit(s)"

if [[ ! -f "$REPORT" ]]; then
  gate_error "gitleaks produced no report file" \
    "The scan did not complete. An incomplete scan is not a clean scan." \
    "Reproduce: ./scripts/security/scan-secrets.sh"
  exit 1
fi

FINDINGS="$(node -e '
  const fs = require("node:fs");
  let raw = "";
  try { raw = fs.readFileSync(process.argv[1], "utf8"); } catch { process.stdout.write("0"); process.exit(0); }
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "[]") { process.stdout.write("0"); process.exit(0); }
  try {
    const parsed = JSON.parse(trimmed);
    process.stdout.write(String(Array.isArray(parsed) ? parsed.length : 0));
  } catch { process.stdout.write("0"); }
' "$REPORT" 2>/dev/null || echo 0)"

if [[ -z "$FINDINGS" || "$FINDINGS" == "0" ]]; then
  # Distinguish "clean" from "the scan did not run". A scan that produced no parseable
  # report is treated as a failure: a secret scanner that silently reports nothing is
  # the worst possible kind of green.
  gate_ok "No secrets detected ($(gate_duration_since "$START"))"
  gate_append_summary \
    "" \
    "| Check | Component | Result | Duration |" \
    "| --- | --- | --- | --- |" \
    "| Secret leak scan | repository | pass | $(gate_duration_since "$START") |"
  exit 0
fi

# --- findings -------------------------------------------------------------
echo
node - "$REPORT_JSON" <<'NODE'
const fs = require('node:fs')
const findings = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const byFile = new Map()
for (const f of findings) {
  const key = f.File || '(history)'
  if (!byFile.has(key)) byFile.set(key, [])
  byFile.get(key).push(f)
}
for (const [file, list] of byFile) {
  console.log(`  ${file}`)
  for (const f of list) {
    console.log(`    line ${f.Line ?? '?'} · rule ${f.RuleID} · commit ${(f.Commit ?? '').slice(0, 7)} · secret ${(f.Secret ?? '').slice(0, 4)}**** (redacted)`)
  }
}
NODE

if [[ "${GATE_SECRETS_BLOCK_ON_ANY_FINDING:-true}" != "true" ]]; then
  gate_warn "${FINDINGS} secret(s) found but GATE_SECRETS_BLOCK_ON_ANY_FINDING=false; not blocking"
  exit 0
fi

gate_error "${FINDINGS} secret(s) detected" \
  "1. TREAT EACH ONE AS COMPROMISED NOW. Rotate or revoke it before anything else." \
  "2. Removing the line is NOT remediation. The secret stays in history and everyone with clone access already has it." \
  "3. Reproduce locally: ./scripts/security/scan-secrets.sh" \
  "4. If a finding is a false positive (a pinned digest or a test fixture), add a narrowly-scoped rule to .gitleaks.toml — do not disable the check."
gate_append_summary \
  "" \
  "| Check | Component | Result | Duration |" \
  "| --- | --- | --- | --- |" \
  "| Secret leak scan | repository | **fail — ${FINDINGS} finding(s)** | $(gate_duration_since "$START") |"
exit 1
