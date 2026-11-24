#!/usr/bin/env bash
# Lint the workflow definitions themselves.
#
# WHY THIS IS A BLOCKING CHECK
# A syntax error in a workflow YAML does not fail the pipeline that contains it —
# it means the pipeline never runs. A required check that never runs reads as
# "still pending", or is satisfied by a skip. Catching that in review is far
# cheaper than discovering it during a release.
#
# actionlint also catches mistakes the YAML parser happily accepts: a typo in a
# `github.` context, an `if:` comparing the wrong type, a step referencing an
# undeclared step id, or a `uses:` SHA with no matching tag comment.
set -uo pipefail

# shellcheck source=scripts/lib/gate-bootstrap.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/gate-bootstrap.sh"

START=$(date +%s)
IMAGE="$(gate_read_key "$ROOT/.github/ci/tools.lock.env" ACTIONLINT_IMAGE || true)"

gate_step "CI self-check · Workflow lint (actionlint)"

if [[ -z "$IMAGE" || "$IMAGE" != *"@sha256:"* ]]; then
  gate_error "ACTIONLINT_IMAGE is missing or not digest-pinned in .github/ci/tools.lock.env" \
    "Add 'ACTIONLINT_IMAGE=docker.io/rhysd/actionlint:<tag>@sha256:<digest>'."
  exit 1
fi

gate_log "analyser: ${IMAGE}"

if command -v docker >/dev/null 2>&1; then
  # The official container keeps this check working on any machine with no
  # per-developer install, and the digest pin means a new actionlint release
  # cannot silently start failing an unrelated PR.
  gate_group "actionlint (container)"
  # Read-only mount, so a buggy analyser cannot rewrite the workflows it is
  # reviewing.
  if docker run --rm \
    -v "${ROOT}":/work:ro \
    -w /work \
    "$IMAGE" -no-color; then
    STATUS=0
  else
    STATUS=1
  fi
  gate_endgroup
else
  # Local fallback for a machine without Docker. Same exit semantics, so CI and a
  # laptop agree on what "pass" means.
  if ! command -v actionlint >/dev/null 2>&1; then
    gate_warn "Neither docker nor actionlint is available; skipping the workflow lint locally"
    echo "CI always runs this check, so a local skip cannot hide a real failure."
    exit 0
  fi
  actionlint -no-color "${ROOT}"/.github/workflows/*.yml && STATUS=0 || STATUS=1
fi

if (( STATUS == 0 )); then
  gate_ok "Workflow definitions are valid ($(gate_duration_since "$START"))"
else
  gate_error "Workflow definition lint failed" \
    "Reproduce: docker run --rm -v \"\$PWD\":/work:ro -w /work ${IMAGE} -no-color" \
    "actionlint prints file:line for every problem; fix them all, not just the first."
fi

exit "$STATUS"
