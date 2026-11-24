#!/usr/bin/env bash
# Backend quality gate: format, static analysis, unit tests, build.
#
#   ./scripts/check-backend.sh          # run everything, in order
#   ./scripts/check-backend.sh vet      # run one validation
#
# WHY IT TAKES A SUBCOMMAND
# So CI can give each validation its own named step: a red Checks tab then names
# the failed validation without anyone opening a log. CI and local runs execute
# the same commands either way.
#
# ORDER when running everything (requirement 7):
# gofmt is near-instant and catches the most common omission; go vet is cheap and
# catches real bugs; tests next; build last.
#
# A NOTE ON GO: `go test ./...` compiles the packages it runs, so a compilation
# error can surface in the test step. That is acceptable for a gate — the step
# name says what failed. The explicit build step still earns its place because it
# compiles the *production* binary the way the Dockerfile and release do, which
# the test run does not cover.
set -uo pipefail

# shellcheck source=scripts/lib/gate-bootstrap.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/gate-bootstrap.sh"

cd "$ROOT/backend" || exit 1

do_fmt() {
  gate_step "Backend · Format check (gofmt)"
  local unformatted
  unformatted="$(gofmt -l .)"
  if [[ -n "$unformatted" ]]; then
    printf '%s\n' "$unformatted"
    gate_error "Backend code is not gofmt-formatted" \
      "Reproduce locally: cd backend && gofmt -l ." \
      "Fix it: cd backend && gofmt -w ."
    return 1
  fi
  gate_ok "All Go files are gofmt-clean"
}

do_vet() {
  gate_step "Backend · Static analysis (go vet)"
  go vet ./... || {
    gate_error "Backend go vet failed" \
      "Reproduce locally: cd backend && go vet ./..."
    return 1
  }
}

do_test() {
  gate_step "Backend · Unit tests (go test)"
  # -count=1 defeats the build cache: a cached "ok" is not evidence that the
  # tests passed for the code under review.
  go test -count=1 ./... || {
    gate_error "Backend unit tests failed" \
      "Reproduce locally: cd backend && go test -count=1 ./..." \
      "Verbose: cd backend && go test -count=1 -v ./..."
    return 1
  }
}

do_build() {
  gate_step "Backend · Build validation (go build)"
  mkdir -p bin
  go build -trimpath -o bin/api ./cmd/api || {
    gate_error "Backend build failed" \
      "Reproduce locally: cd backend && go build -o bin/api ./cmd/api"
    return 1
  }
  gate_ok "Binary built at backend/bin/api"
}

usage() {
  cat <<'USAGE'
usage: scripts/check-backend.sh [fmt|vet|test|build|all]

  fmt     gofmt -l . (must report nothing)
  vet     go vet ./...
  test    go test -count=1 ./...
  build   go build ./cmd/api
  all     fmt + vet + test + build (default)
USAGE
}

TARGET="${1:-all}"
START=$(date +%s)

case "$TARGET" in
  fmt) do_fmt ;;
  vet) do_vet ;;
  test) do_test ;;
  build) do_build ;;
  all) do_fmt && do_vet && do_test && do_build ;;
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
  gate_ok "Backend '${TARGET}' PASSED in $(gate_duration_since "$START")"
else
  gate_error "Backend '${TARGET}' FAILED in $(gate_duration_since "$START")" \
    "Re-run just this check: ./scripts/check-backend.sh ${TARGET}"
fi

exit "$STATUS"
