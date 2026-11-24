#!/usr/bin/env bash
# Verify the change-detection filters are still telling the truth.
#
# WHY THIS IS A BLOCKING CHECK
# Requirement 5 (change-aware execution) is the one requirement that can fail
# silently in the *dangerous* direction. If someone adds `mobile/` to the repo and
# forgets to add a filter, mobile changes trigger nothing, every check reports
# "skipped", the aggregate gate passes, and unvalidated code merges. The pipeline
# looks green precisely because it is blind.
#
# This check makes that mistake fail loudly.
set -uo pipefail

# shellcheck source=scripts/lib/gate-bootstrap.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/gate-bootstrap.sh"

START=$(date +%s)
STATUS=0
FILTERS="$ROOT/.github/ci/paths-filter.yaml"
WORKFLOW="$ROOT/.github/workflows/pr-quality-gate.yml"

gate_step "CI self-check · Path filters cover every component"

fail() {
  gate_error "$1" "${@:2}"
  STATUS=1
}

[[ -f "$FILTERS" ]] || {
  gate_error "Path filter file is missing: .github/ci/paths-filter.yaml" \
    "Restore it; the PR workflow cannot decide what to run without it."
  exit 1
}

# --- 1. every top-level directory with real code must be covered ----------
# A component counts as "needing coverage" when it contains buildable source.
# docs/, scripts/ and .github/ are handled by the `shared` filter.
covered_by_shared() {
  # Is this directory reachable from the `shared` filter's patterns?
  local dir="$1"
  awk '/^shared:/{flag=1;next} /^[^[:space:]#]/{flag=0} flag' "$FILTERS" |
    grep -qF "'${dir}/"
}

for dir in */; do
  dir="${dir%/}"
  case "$dir" in
    node_modules | dist | coverage | bin | docs | scripts | .?.*) continue ;;
  esac

  # Only care about directories that actually contain code worth validating.
  has_code=0
  if compgen -G "${dir}/*.go" >/dev/null || compgen -G "${dir}/*.ts" >/dev/null ||
    [[ -f "${dir}/go.mod" || -f "${dir}/package.json" ]]; then
    has_code=1
  fi
  (( has_code )) || continue

  if [[ "$dir" == "frontend" || "$dir" == "backend" ]]; then
    grep -qE "^${dir}:" "$FILTERS" ||
      fail "'${dir}' has no filter in .github/ci/paths-filter.yaml" \
        "Add a '${dir}:' filter, otherwise changes to it never trigger its gate."
    continue
  fi

  # New code component: it must appear somewhere in the filters.
  if ! grep -qF "'${dir}/" "$FILTERS"; then
    fail "Code component '${dir}/' is not covered by any path filter" \
      "Changes to ${dir}/ would trigger no gate and merge unvalidated." \
      "Add '${dir}/**' to the relevant filter in .github/ci/paths-filter.yaml."
  fi
done

# --- 2. the workflow must consume every filter it defines ----------------
# An orphan filter is usually a copy-paste leftover: it costs evaluation time and
# misleads the next reader into thinking something is gated when nothing is.
for filter_name in $(grep -E '^[a-z_]+:' "$FILTERS" | cut -d: -f1); do
  [[ "$filter_name" == "docs" ]] && continue
  if ! grep -q "outputs\.${filter_name}" "$WORKFLOW"; then
    fail "Filter '${filter_name}' is defined but the PR workflow never reads it" \
      "Either use needs.detect-changes.outputs.${filter_name} or remove the filter."
  fi
done

# --- 3. every declared job output must actually be produced --------------
# An output wired to nothing is always the empty string, so its dependent job's
# `if` never matches and the job silently never runs. That is indistinguishable
# from "correctly skipped" — the same silent-blindness failure as check 1.
while read -r output_name; do
  [[ -z "$output_name" ]] && continue
  # Either it mirrors a filter of the same name...
  if grep -qE "^${output_name}:" "$FILTERS"; then
    continue
  fi
  # ...or a step in the workflow explicitly sets it.
  if grep -qE "^[[:space:]]*id:[[:space:]]*${output_name}\$" "$WORKFLOW" ||
    grep -qE "\"${output_name}=" "$WORKFLOW"; then
    continue
  fi
  fail "Workflow output '${output_name}' is never produced" \
    "Nothing sets it, so it is always empty and any job gated on it never runs."
done < <(awk '/^    outputs:/{flag=1;next} /^    [a-z]/{flag=0} flag' "$WORKFLOW" |
  sed -n 's/^[[:space:]]*\([a-z_][a-z_]*\):.*/\1/p')

# --- 4. every file a Dockerfile copies must trigger that image's docker filter --
# This catches a bug that actually occurred while building this POC: nginx.conf was
# COPYed by frontend/Dockerfile but was absent from the `frontend_docker` filter, so
# a change that made the container fail to start would have skipped the only job able
# to detect it. The Dockerfile and the filter drifted apart and nothing complained.
#
# The local matcher models the glob subset and exclusion policy used by the pinned action.

# Results are gathered per Dockerfile in one node invocation: the matcher is fast but node
# start-up is not, and this loop would otherwise spawn a process per COPY line. The wrapper
# is a shell script so the node-absent case produces a readable error instead of a stack
# trace from a binary trying to parse bash.
filter_paths_query() {
  "$ROOT/scripts/ci/lib/filter-query.sh" "$@"
}

# filter_has_broad_pattern <filter_name> <component> — does the filter cover the
# whole component directory, which is what makes `COPY . .` safe to filter?
filter_has_broad_pattern() {
  local filter="$1" component="$2"
  awk -v f="$filter" -v c="$component" '
    $0 ~ "^" f ":" { inside = 1; next }
    /^[^[:space:]#]/ { inside = 0 }
    inside {
      whole = "\047" c "/**\047"
      flat = "\047" c "/*\047"
      if (index($0, whole) || index($0, flat)) found = 1
    }
    END { exit found ? 0 : 1 }
  ' "$FILTERS"
}

while read -r dockerfile; do
  case "$dockerfile" in
    *frontend*) component=frontend; filter_name=frontend_docker ;;
    *backend*) component=backend; filter_name=backend_docker ;;
    *) continue ;;
  esac

  # Sources of every COPY/ADD: all non-flag arguments except the last, which is the
  # destination inside the image.
  #
  # Positional, not value-based: a naive "skip arguments equal to the destination"
  # filter silently drops `COPY . .`, where both operands are identical. That is the
  # most important case to detect, since a whole-context copy is exactly the shape a
  # narrow path filter cannot cover.
  sources="$(awk '
    /^COPY[[:space:]]/ || /^ADD[[:space:]]/ {
      n = 0
      for (i = 2; i <= NF; i++) if ($i !~ /^--/) args[++n] = $i
      for (i = 1; i < n; i++) print args[i]
      delete args
    }
  ' "$dockerfile" 2>/dev/null || true)"

  if [[ -z "$sources" ]]; then
    # A Dockerfile with no COPY/ADD at all is worth naming rather than passing over: this
    # loop's whole job is checking copied files are filtered, and finding none is the case
    # where it has verified nothing. Silent success is the failure mode being avoided here.
    gate_warn "$(basename "$(dirname "$dockerfile")")/Dockerfile has no COPY or ADD instructions — the path-filter coverage check verified nothing for it"
    continue
  fi

  # `COPY . .` pulls in the whole context, so no individual file list can cover it.
  # Worth saying out loud: with a narrow filter, a future file can affect the image
  # without ever triggering the job that builds it.
  if printf '%s\n' "$sources" | grep -qxE '\./?'; then
    if ! filter_has_broad_pattern "$filter_name" "$component"; then
      gate_warn "$(basename "$(dirname "$dockerfile")")/Dockerfile copies the whole context, but '${filter_name}' lists specific paths"
      echo "        A new file under ${component}/ can change the image without triggering '${filter_name}'."
      echo "        Either list COPY sources explicitly, or add '${component}/**' to '${filter_name}'."
    fi
  fi

  # Concrete, context-relative paths only: a glob source (`COPY conf.d/*.conf /x`) is a
  # pattern, not a file, and there is nothing to look up for it.
  concrete="$(printf '%s\n' "$sources" |
    grep -v '^/' | grep -vxE '\./?' | grep -v '[*?]' |
    sed "s|^|${component}/|" || true)"
  [[ -z "$concrete" ]] && continue

  # One batched query for this Dockerfile. An unexpected exit code is a failure of the check,
  # never a pass: a matcher that could not run has not covered anything.
  if ! result="$(printf '%s\n' "$concrete" | filter_paths_query "$filter_name" 2>&1)"; then
    fail "Could not evaluate path filters for '${component}'" \
      "scripts/ci/lib/filter-query.mjs exited non-zero, so coverage is unknown — not clean." \
      "$result"
    continue
  fi

  while IFS=$'\t' read -r path hits; do
    [[ -z "$path" ]] && continue
    if [[ "$hits" == "-" ]]; then
      fail "Dockerfile for '${component}' copies ${path}, but no '${filter_name}' pattern matches it" \
        "A change to ${path} would skip '${filter_name}' — the only job that builds and runs the image." \
        "Add '${path}' to the '${filter_name}' filter in .github/ci/paths-filter.yaml."
    fi
  done <<<"$result"
done < <(find "$ROOT" -name Dockerfile -not -path "*/node_modules/*")

# --- 5. the aggregate gate must guard against a skipped required check ---
if ! grep -q "if: always()" "$WORKFLOW"; then
  fail "The aggregate quality-gate job is missing 'if: always()'" \
    "Without it, a failed dependency makes the aggregate job skip, and a skipped job satisfies branch protection."
fi

if (( STATUS == 0 )); then
  gate_ok "Path filters cover all components ($(gate_duration_since "$START"))"
fi

exit "$STATUS"
