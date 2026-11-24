#!/usr/bin/env bash
# Frontend dependency vulnerability scan (security baseline, requirement 8).
#
# WHAT IS CHECKED
# `npm audit` against the lockfile, triaged by scripts/security/npm-audit-gate.mjs:
#   - production dependency graph: HIGH and CRITICAL block
#   - dev/build-only graph: reported, not blocking
# Thresholds live in .ci/security-policies.env, not in this file.
#
# WHY NOT JUST `npm audit --audit-level=high`
# npm has no way to apply different severities to production vs dev-only
# dependencies, and `npm ci --omit=dev` would miss the dev graph entirely. The
# triage script compares both graphs so the policy is explicit and testable.
set -uo pipefail

# shellcheck source=scripts/lib/gate-bootstrap.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/gate-bootstrap.sh"
gate_load_policy "$ROOT/.ci/security-policies.env" || exit 1

cd "$ROOT/frontend" || exit 1
START=$(date +%s)

NODE_VERSION="$(gate_read_asdf_version "$ROOT/.tool-versions" nodejs || echo 'per .tool-versions')"
gate_require_cmd npm "Install Node.js ${NODE_VERSION} (see .tool-versions)." || exit 1

if [[ ! -f package-lock.json ]]; then
  gate_error "frontend/package-lock.json is missing" \
    "Run 'npm install' in frontend/ and commit the lockfile. Without it, CI resolves a different dependency tree on every run."
  exit 1
fi

# `npm audit` exits non-zero when it finds anything, which is the input to our
# triage, not a verdict. Capture the exit code, never let `set -e` decide.
audit_npm() {
  local out="$1"
  shift
  npm audit --json "$@" >"$out" 2>"$out.err"
  local code=$?
  # 0 = clean, 1 = vulnerabilities found. Anything else is a real failure.
  if (( code > 1 )); then
    gate_error "'npm audit $*' failed with exit code $code" "$(tail -5 "$out.err")"
    return 1
  fi
  return 0
}

gate_step "Frontend · Dependency audit"

PROD_JSON=$(mktemp)
FULL_JSON=$(mktemp)
trap 'rm -f "$PROD_JSON" "$FULL_JSON" "$PROD_JSON.err" "$FULL_JSON.err"' EXIT

audit_npm "$PROD_JSON" --omit=dev || exit 1
audit_npm "$FULL_JSON" || exit 1

node "$ROOT/scripts/security/npm-audit-gate.mjs" \
  --prod-json "$PROD_JSON" \
  --full-json "$FULL_JSON" \
  --prod-blocking "${GATE_NPM_BLOCKING_SEVERITY_PROD:-critical,high}" \
  --dev-blocking "${GATE_NPM_BLOCKING_SEVERITY_DEV:-}"
GATE_STATUS=$?

if (( GATE_STATUS == 0 )); then
  gate_ok "Frontend dependency audit passed in $(gate_duration_since "$START")"
else
  gate_error "Frontend dependency audit failed" \
    "Reproduce with: npm audit --omit=dev   (in frontend/)" \
    "Policy source: .ci/security-policies.env"
fi

gate_append_summary \
  "" \
  "| Check | Component | Result | Duration |" \
  "| --- | --- | --- | --- |" \
  "| Dependency audit | frontend | $([[ $GATE_STATUS -eq 0 ]] && echo 'pass' || echo 'fail') | $(gate_duration_since "$START") |" \
  "| Blocking policy | frontend | prod: \`${GATE_NPM_BLOCKING_SEVERITY_PROD:-critical,high}\` dev-only: \`${GATE_NPM_BLOCKING_SEVERITY_DEV:-none}\` | |"

exit "$GATE_STATUS"
