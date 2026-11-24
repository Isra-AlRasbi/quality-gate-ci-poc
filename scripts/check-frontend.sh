#!/usr/bin/env bash
# Frontend quality gate: lint, type check, unit tests, build.
#
#   ./scripts/check-frontend.sh            # run everything, in order
#   ./scripts/check-frontend.sh lint       # run one validation
#
# WHY IT TAKES A SUBCOMMAND
# GitHub Actions shows a per-step tick or cross. If CI ran this script once with
# no argument, every failure would look identical in the Checks tab: one red
# "Run quality gate" step that you have to open to understand. By exposing one
# subcommand per validation, CI can call each as its own named step and the
# failing check is readable at a glance — while CI and a developer laptop still
# execute byte-identical commands. Same entry point, two shapes.
#
# ORDER when running everything (requirement 7: fast, actionable feedback):
# cheapest and most common failure classes first, so a lint or type mistake is
# reported in seconds rather than after a full build.
set -uo pipefail

# shellcheck source=scripts/lib/gate-bootstrap.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/gate-bootstrap.sh"

cd "$ROOT/frontend" || exit 1

do_install() {
  gate_step "Frontend · Install dependencies"
  if [[ ! -f package-lock.json ]]; then
    gate_error "frontend/package-lock.json is missing" \
      "Run 'npm install' in frontend/ and commit the lockfile. Without it, CI resolves a different dependency tree on every run."
    return 1
  fi
  local lock_sha
  lock_sha="$(gate_sha256 package-lock.json)"
  local marker="node_modules/.quality-gate-lockfile"

  if [[ -d node_modules ]]; then
    # Trusting any existing node_modules is the hole here. In CI it never exists, so a
    # CI-only script would never notice; on a laptop it means switching branches and running
    # the gate can lint, type check and test a dependency tree left over from the branch you
    # just left. The whole point of the gate is that CI and a laptop run the same tree, so
    # the marker is stamped at install time and compared here.
    if [[ -f "$marker" ]] && [[ "$(cat "$marker" 2>/dev/null)" == "$lock_sha" ]]; then
      gate_log "node_modules matches the current lockfile; skipping install"
      return 0
    fi
    gate_log "node_modules does not match the current lockfile; reinstalling"
  fi

  # `npm ci` is the CI install: it refuses to resolve anything absent from the lockfile,
  # which is what keeps the dependency graph identical everywhere. What it does and does not
  # reject was measured on npm 10.9.8 rather than assumed -- see docs/security-baseline.md.
  # It refuses on a missing lockfile, a package.json version the lockfile lacks, an extra
  # dependency, and a mismatched integrity hash. It accepts a bogus `lockfileVersion` and a
  # repointed `resolved` host, which is why the exit code alone is not the whole guarantee.
  if ! npm ci --no-audit --no-fund; then
    gate_error "npm ci failed" "Reproduce locally: cd frontend && npm ci"
    return 1
  fi

  # Invariant, not a measured bug: npm 10.9.8 left package-lock.json byte-identical under
  # every tamper shape tested. If a future npm starts normalising it, an install that
  # rewrites its own input has just decided the dependency graph rather than reading the one
  # under review, and that should fail here instead of appearing as an unrelated diff later.
  if [[ "$lock_sha" != "$(gate_sha256 package-lock.json)" ]]; then
    gate_error "npm ci rewrote frontend/package-lock.json" \
      "The installed tree did not come from the committed lockfile, so this run's dependency graph is not the one under review." \
      "Run 'npm install' in frontend/, inspect the diff, and commit the result deliberately." \
      "Do not commit the rewrite as part of an unrelated PR."
    return 1
  fi

  printf '%s\n' "$lock_sha" >"$marker"
  gate_ok "Dependencies installed from the lockfile"
}

do_lint() {
  gate_step "Frontend · Lint (eslint)"
  npm run --silent lint || {
    gate_error "Frontend lint failed" \
      "Reproduce locally: cd frontend && npm run lint" \
      "Auto-fixable violations: cd frontend && npm run lint:fix"
    return 1
  }
}

do_typecheck() {
  gate_step "Frontend · Type check (tsc --noEmit)"
  npm run --silent typecheck || {
    gate_error "Frontend type check failed" \
      "Reproduce locally: cd frontend && npm run typecheck"
    return 1
  }
}

do_test() {
  gate_step "Frontend · Unit tests (vitest)"
  # Runs with coverage on purpose: vitest.config.ts declares coverage thresholds, and a
  # threshold no command ever evaluates is worse than no threshold at all -- it reads as
  # enforced policy while doing nothing. `--coverage` applies them and fails the run when
  # they are not met. Measured cost on this repository: ~200ms.
  npm run --silent test:coverage || {
    gate_error "Frontend unit tests failed (or coverage fell below its threshold)" \
      "Reproduce locally: cd frontend && npm run test:coverage" \
      "Tests only, ignoring coverage: cd frontend && npm run test" \
      "Watch mode while fixing: cd frontend && npm run test:watch" \
      "Thresholds live in frontend/vitest.config.ts. Lowering one is a policy decision: say so in the PR description."
    return 1
  }
}

do_build() {
  gate_step "Frontend · Build validation (vite build)"
  npm run --silent build || {
    gate_error "Frontend build failed" \
      "Reproduce locally: cd frontend && npm run build"
    return 1
  }
  gate_ok "Production bundle emitted to frontend/dist"
}

usage() {
  cat <<'USAGE'
usage: scripts/check-frontend.sh [install|lint|typecheck|test|build|all]

  install     npm ci from the lockfile
  lint        eslint
  typecheck   tsc --noEmit
  test        vitest run --coverage (enforces the thresholds in vitest.config.ts)
  build       vite build
  all         install + lint + typecheck + test + build (default)
USAGE
}

TARGET="${1:-all}"
START=$(date +%s)

case "$TARGET" in
  install) do_install ;;
  lint) do_install && do_lint ;;
  typecheck) do_install && do_typecheck ;;
  test) do_install && do_test ;;
  build) do_install && do_build ;;
  all)
    do_install && do_lint && do_typecheck && do_test && do_build
    ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    gate_error "Unknown target '$TARGET'" "$(usage | tr '\n' ' ')"
    exit 2
    ;;
esac

STATUS=$?

if (( STATUS == 0 )); then
  gate_ok "Frontend '${TARGET}' PASSED in $(gate_duration_since "$START")"
else
  gate_error "Frontend '${TARGET}' FAILED in $(gate_duration_since "$START")" \
    "Re-run just this check: ./scripts/check-frontend.sh ${TARGET}"
fi

exit "$STATUS"
