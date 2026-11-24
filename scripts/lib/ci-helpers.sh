#!/usr/bin/env bash
# Shared helpers for the CI gate scripts.
#
# WHY THIS EXISTS
# Requirement 7 (clear failure feedback) depends on *consistent* output. If each
# script invents its own error format, developers learn to skim. Everything here
# exists to make one failure look like every other failure:
#
#   [gate][ERROR] <what failed> in <component>
#   [gate][ERROR] fix: <the command to run locally>
#
# Source it, do not execute it.
# shellcheck shell=bash

GATE_LOG_PREFIX="[gate]"

# GATE_ROOT — the repository root, derived from *this file's* location.
#
# WHY THIS IS HERE RATHER THAN IN EACH SCRIPT
# Every gate script needs the repo root, and every script that computes it
# independently gets to make its own off-by-one-directory mistake. This actually
# happened in this POC: scripts in scripts/ci/ used `dirname/..` and resolved
# scripts/, so every helper call failed. Since this file always lives at
# scripts/lib/ci-helpers.sh, its own path pins the root exactly once, and a script
# that sources it can simply use $GATE_ROOT.
GATE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export GATE_ROOT

gate_log() { printf '%s %s\n' "$GATE_LOG_PREFIX" "$*"; }

gate_step() { printf '\n%s ── %s\n' "$GATE_LOG_PREFIX" "$*"; }

gate_ok() { printf '%s [OK]    %s\n' "$GATE_LOG_PREFIX" "$*"; }

# gate_error <summary> [remediation...]
#
# The remediator line is the point of the whole function: a CI failure that
# names the command to run locally turns "the bot is red" into a 30-second fix.
gate_error() {
  local summary="$1"
  shift
  printf '::error::%s\n' "$summary"
  printf '%s [ERROR] %s\n' "$GATE_LOG_PREFIX" "$summary"
  for hint in "$@"; do
    printf '%s [ERROR] fix: %s\n' "$GATE_LOG_PREFIX" "$hint"
  done
}

# gate_warn <message> — visible in the PR's Files changed tab, does not fail.
gate_warn() {
  printf '::warning::%s\n' "$1"
  printf '%s [WARN]  %s\n' "$GATE_LOG_PREFIX" "$1"
}

# gate_group <title> / gate_endgroup — collapse noisy tool output in the log.
gate_group() { printf '::group::%s\n' "$1"; }
gate_endgroup() { printf '::endgroup::\n'; }

# gate_append_summary <markdown...>
#
# GitHub only renders $GITHUB_STEP_SUMMARY on a runner. Outside CI the same
# arguments are printed, one per line, so local runs and CI runs produce the same
# information. One line per argument matters: these calls build markdown tables, and
# joining them with spaces would produce an unreadable single line locally while
# rendering correctly in CI — meaning nobody could check the summary format without
# pushing.
gate_append_summary() {
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf '%s\n' "$@" >>"$GITHUB_STEP_SUMMARY"
  else
    local line
    for line in "$@"; do
      printf '%s %s\n' "$GATE_LOG_PREFIX" "$line"
    done
  fi
}

# gate_set_output <name> <value> — step output for use in later steps.
gate_set_output() {
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf '%s=%s\n' "$1" "$2" >>"$GITHUB_OUTPUT"
  fi
  gate_log "output $1=$2"
}

# gate_load_policy <file> — read the shared security thresholds safely.
# Values become GATE_* variables; nothing is eval'd or executed.
gate_load_policy() {
  local policy_file="$1"

  if [[ ! -f "$policy_file" ]]; then
    gate_error "Security policy file not found: $policy_file" \
      "Restore .ci/security-policies.env or point GATE_POLICY_FILE at it."
    return 1
  fi

  while IFS='=' read -r key value; do
    # Skip comments and blank lines.
    [[ -z "$key" || "$key" =~ ^[[:space:]]*# ]] && continue
    [[ "$key" =~ ^[A-Z0-9_]+$ ]] || continue
    # Strip an inline comment (only when preceded by whitespace, so a value
    # containing '#' survives) and surrounding whitespace. Without this, a line
    # like `FOO=high   # blocks X` exported the comment as part of the value.
    value="${value%%$'\t'*}"
    value="$(printf '%s' "$value" | sed -E 's/[[:space:]]+#.*$//')"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    export "GATE_${key}=${value}"
  done < <(grep -v '^[[:space:]]*#' "$policy_file" | grep '=' || true)

  gate_log "loaded security policy from $policy_file"
}

# gate_duration_since <epoch-seconds>
gate_duration_since() {
  local start="$1"
  local elapsed=$(( $(date +%s) - start ))
  if (( elapsed < 60 )); then
    printf '%ss' "$elapsed"
  else
    printf '%dm %ds' $(( elapsed / 60 )) $(( elapsed % 60 ))
  fi
}

# gate_require_cmd <cmd> <hint> — fail early and clearly on a missing tool
# rather than with a confusing "command not found" halfway through a job.
gate_require_cmd() {
  local cmd="$1" hint="${2:-}"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    gate_error "Required command not available: $cmd" ${hint:+"$hint"}
    return 1
  fi
}

# gate_read_key <file> <KEY> — read `KEY=value` from a config file.
#
# Prefer this over a regex whenever the source is `KEY=value`: no pattern to
# escape, and image references containing `/` or `|` work without ceremony.
# Surrounding whitespace and trailing comments are stripped. Prints nothing and
# returns 1 when the key is absent, so `[[ -z "$(...)" ]]` is a valid presence test.
gate_read_key() {
  local file="$1" key="$2" line value
  [[ -f "$file" ]] || return 1

  line="$(grep -m1 -E "^[[:space:]]*${key}=" "$file" 2>/dev/null)" || return 1
  value="${line#*=}"
  # Drop a trailing inline comment, but only when preceded by whitespace, so a
  # value legitimately containing '#' is untouched.
  value="$(printf '%s' "$value" | sed -E 's/[[:space:]]+#.*$//')"
  # Trim leading/trailing whitespace.
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"

  [[ -n "$value" ]] || return 1
  printf '%s\n' "$value"
}

# gate_read_asdf_version <file> <tool> — read a pinned version from a
# `.tool-versions`-style file (`<tool> <version>` per line).
#
# WHY NOT ONE GENERIC REGEX READER
# A helper that takes a sed pattern looked general, and was not: patterns
# containing `/` (every container image reference) silently produced a broken sed
# expression, and the failure surfaced as an empty version far from its cause. Two
# small readers for the two real file shapes are both safer and easier to read.
gate_read_asdf_version() {
  local file="$1" tool="$2" line version
  [[ -f "$file" ]] || return 1

  line="$(grep -m1 -E "^[[:space:]]*${tool}[[:space:]]+" "$file" 2>/dev/null)" || return 1
  version="$(printf '%s' "$line" | awk '{print $2}')"
  [[ -n "$version" ]] || return 1
  printf '%s\n' "$version"
}

# gate_sha256 <file> — checksum used to detect a file changing underneath a step.
#
# Used to bind `node_modules` to the lockfile it was installed from, and to assert that
# `npm ci` does not modify its own input. Both are cases where "the command exited 0" and
# "the thing I meant to verify held" are different claims. Falls back across the two tools
# that exist on the images CI actually uses, so this does not depend on coreutils.
gate_sha256() {
  local file="$1"
  [[ -f "$file" ]] || return 1
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    gate_error "Neither sha256sum nor shasum is available" \
      "Cannot verify that $file was left unmodified."
    return 1
  fi
}
