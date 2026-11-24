#!/usr/bin/env bash
# Backend Go vulnerability scan (security baseline, requirement 8).
#
# WHAT IS CHECKED
# `govulncheck` in symbol mode: it follows the call graph and reports only the
# vulnerabilities this program can actually reach, rather than every package in
# the module graph. The verdict is computed by
# scripts/security/govulncheck-gate.mjs from the parsed findings.
#
# THE TRAP THIS SCRIPT AVOIDS
# `govulncheck -format=json` exits 0 even when it finds vulnerabilities; only text
# mode exits 3. Running the JSON format and trusting the exit code reports a
# vulnerable build as green. So the scan's exit status is used only to answer "did
# the tool run", never "is the code safe".
#
# WHY govulncheck IS INSTALLED PER RUN
# govulncheck must be built with the same Go major version as the toolchain on
# PATH, or it fails to load packages and reports nothing at all. Caching the binary
# across Go upgrades therefore produces a silent false green. `go install` of a
# pinned version is a couple of seconds and always matches.
set -uo pipefail

# shellcheck source=scripts/lib/gate-bootstrap.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/gate-bootstrap.sh"
gate_load_policy "$ROOT/.ci/security-policies.env" || exit 1

cd "$ROOT/backend" || exit 1
START=$(date +%s)

GO_VERSION="$(gate_read_asdf_version "$ROOT/.tool-versions" golang || true)"
GOVULNCHECK_VERSION="$(gate_read_key "$ROOT/.github/ci/tools.lock.env" GOVULNCHECK_VERSION || true)"

gate_step "Backend · Go vulnerability scan (govulncheck ${GOVULNCHECK_VERSION:-unpinned})"

gate_require_cmd go "Install Go ${GO_VERSION:-see .tool-versions} or add it to PATH." || exit 1
gate_require_cmd node "Install Node.js — the triage gate is a Node script." || exit 1

if [[ -z "${GOVULNCHECK_VERSION}" ]]; then
  gate_error "govulncheck version is not pinned" \
    "Set GOVULNCHECK_VERSION in .github/ci/tools.lock.env."
  exit 1
fi

# Keep the toolchain deterministic. Without GOTOOLCHAIN=local, a version that is
# not installed is downloaded silently, which hides drift between .tool-versions
# and the machine actually running the gate.
export GOTOOLCHAIN=local
gate_log "toolchain: $(go env GOVERSION) (pinned: go${GO_VERSION})"

GOBIN_DIR="${GOBIN:-$(go env GOPATH)/bin}"
export PATH="${GOBIN_DIR}:${PATH}"

gate_group "Install govulncheck ${GOVULNCHECK_VERSION}"
if ! go install "golang.org/x/vuln/cmd/govulncheck@${GOVULNCHECK_VERSION}"; then
  gate_endgroup
  gate_error "Could not install govulncheck ${GOVULNCHECK_VERSION}" \
    "Confirm the tag exists: https://pkg.go.dev/golang.org/x/vuln/cmd/govulncheck?tab=versions"
  exit 1
fi
gate_endgroup

SCAN_JSON="$(mktemp)"
SCAN_ERR="$(mktemp)"
trap 'rm -f "$SCAN_JSON" "$SCAN_ERR"' EXIT

gate_group "Run govulncheck (symbol mode)"
# Not guarded by `set -e` on purpose: non-zero here means "findings exist", and the
# parser decides whether those findings block. See the header.
govulncheck -format=json ./... >"$SCAN_JSON" 2>"$SCAN_ERR"
SCAN_EXIT=$?
gate_endgroup

if [[ ! -s "$SCAN_JSON" ]]; then
  gate_error "govulncheck produced no output (exit ${SCAN_EXIT})" \
    "$(tail -8 "$SCAN_ERR" 2>/dev/null)" \
    "An empty scan is NOT a clean scan. Do not add a fallback that treats it as one."
  exit 1
fi

node "$ROOT/scripts/security/govulncheck-gate.mjs" \
  --input "$SCAN_JSON" \
  --block-third-party "${GATE_GO_BLOCK_REACHABLE_THIRD_PARTY:-true}" \
  --block-stdlib "${GATE_GO_BLOCK_ON_STDLIB_FINDINGS:-false}"
GATE_STATUS=$?

if (( GATE_STATUS == 0 )); then
  gate_ok "Backend Go vulnerability scan passed in $(gate_duration_since "$START")"
else
  gate_error "Backend Go vulnerability scan failed" \
    "Reproduce with: govulncheck ./   (in backend/)" \
    "Policy source: .ci/security-policies.env"
fi

exit "$GATE_STATUS"
