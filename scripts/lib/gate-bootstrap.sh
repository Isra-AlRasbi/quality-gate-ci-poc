#!/usr/bin/env bash
# Bootstrap: locate scripts/lib/ci-helpers.sh and source it, from any directory
# depth. Source this file instead of hardcoding a relative path to the helpers.
#
# WHY THIS EXISTS
# Every gate script needs two things: the helpers, and $GATE_ROOT. Handing each
# script its own `dirname` arithmetic guarantees each one can be off by a
# directory, and that failure is spectacular but confusing (every `gate_*` call
# becomes "command not found"). This actually happened in this POC.
#
# Usage:
#   source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/gate-bootstrap.sh"
# or, for a script at an unknown depth:
#   source "$(dirname "${BASH_SOURCE[0]}")/gate-bootstrap.sh"
#
# After sourcing: $GATE_ROOT is the repository root and all gate_* functions are
# defined.
# shellcheck shell=bash

__gate_find_lib() {
  local dir depth=0
  # Anchor on THIS file's own location, not the caller's. This file is always at
  # scripts/lib/gate-bootstrap.sh, so its path identifies the repository
  # regardless of the caller's depth or working directory — which is exactly what
  # CI needs, since GitHub Actions runs steps from the workspace root.
  dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

  while [[ -n "$dir" && "$dir" != "/" && $depth -lt 8 ]]; do
    if [[ -f "$dir/lib/ci-helpers.sh" ]]; then
      printf '%s' "$dir/lib/ci-helpers.sh"
      return 0
    fi
    if [[ -f "$dir/scripts/lib/ci-helpers.sh" ]]; then
      printf '%s' "$dir/scripts/lib/ci-helpers.sh"
      return 0
    fi
    dir="$(dirname "$dir")"
    depth=$((depth + 1))
  done

  return 1
}

__gate_lib="$(__gate_find_lib)" || {
  printf '[gate][FATAL] cannot find scripts/lib/ci-helpers.sh from %s\n' "$(pwd)" >&2
  printf '[gate][FATAL] fix: run this script from inside the repository checkout\n' >&2
  exit 1
}

# shellcheck source=scripts/lib/ci-helpers.sh
source "$__gate_lib"
unset __gate_lib __gate_find_lib

# Convenience alias; GATE_ROOT is authoritative and defined by ci-helpers.sh.
ROOT="$GATE_ROOT"
