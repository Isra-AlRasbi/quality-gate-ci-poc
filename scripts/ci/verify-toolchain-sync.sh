#!/usr/bin/env bash
# Verify that every place a version is pinned actually agrees.
#
# WHY THIS EXISTS
# GitHub Actions cannot read .tool-versions, so the pins are mirrored into
# .github/ci/toolchain.lock.env for `uses:`/`with:` inputs, and the Dockerfiles
# reference images directly. Mirrors drift. When they do, CI validates one
# version and developers build another — the worst kind of flakiness, because it
# looks like a real failure.
#
# This check turns that class of bug into an instant, obvious PR failure.
set -uo pipefail

# shellcheck source=scripts/lib/gate-bootstrap.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/gate-bootstrap.sh"

STATUS=0
START=$(date +%s)

gate_step "CI self-check · toolchain pins agree everywhere"

fail() {
  gate_error "$1" "${@:2}"
  STATUS=1
}

# --- read .tool-versions -------------------------------------------------
declare -A ASDF
while read -r name version; do
  [[ -z "$name" || "$name" =~ ^# ]] && continue
  ASDF["$name"]="$version"
done < <(grep -Ev '^[[:space:]]*(#|$)' "$ROOT/.tool-versions")

if [[ -z "${ASDF[nodejs]:-}" ]]; then
  fail ".tool-versions has no 'nodejs' entry" "Add 'nodejs <version>' to .tool-versions."
fi
if [[ -z "${ASDF[golang]:-}" ]]; then
  fail ".tool-versions has no 'golang' entry" "Add 'golang <version>' to .tool-versions."
fi

# --- read the Actions mirror --------------------------------------------
declare -A LOCK
while IFS='=' read -r key value; do
  [[ -z "$key" || "$key" =~ ^[[:space:]]*# ]] && continue
  [[ "$key" =~ ^[A-Z0-9_]+$ ]] || continue
  # Strip an inline comment, then surrounding whitespace.
  value="${value%%#*}"
  value="$(printf '%s' "$value" | sed 's/[[:space:]]*$//')"
  LOCK["$key"]="$value"
done <"$ROOT/.github/ci/toolchain.lock.env"

compare() {
  local label="$1" expected="$2" actual="$3" fix_target="$4"
  if [[ -z "$expected" || -z "$actual" ]]; then
    fail "$label: could not compare (expected='${expected}' actual='${actual}')" \
      "Check that both .tool-versions and $fix_target define this value."
  elif [[ "$expected" != "$actual" ]]; then
    fail "$label: mismatch — .tool-versions says '$expected', $fix_target says '$actual'" \
      "Make them match, then commit both files together."
  else
    gate_ok "$label: $actual"
  fi
}

compare "Node.js" "${ASDF[nodejs]:-}" "${LOCK[NODE_VERSION]:-}" ".github/ci/toolchain.lock.env"
compare "Go" "${ASDF[golang]:-}" "${LOCK[GO_VERSION]:-}" ".github/ci/toolchain.lock.env"

# --- Dockerfiles must use the mirrored images ---------------------------
for spec in "NODE_IMAGE:frontend/Dockerfile" "NGINX_IMAGE:frontend/Dockerfile" "GO_BUILD_IMAGE:backend/Dockerfile"; do
  key="${spec%%:*}"
  dockerfile="${spec##*:}"
  expected="${LOCK[$key]:-}"
  path="$ROOT/$dockerfile"

  if [[ -z "$expected" ]]; then
    fail "$key is not defined in .github/ci/toolchain.lock.env" "Add the pinned image reference."
    continue
  fi
  if [[ ! -f "$path" ]]; then
    fail "$dockerfile is missing" "Restore the file."
    continue
  fi

  # A FROM line is `FROM <image>@sha256:... AS stage`; rebuild the same shape.
  if ! grep -qF "FROM ${expected}" "$path"; then
    found="$(grep -E '^FROM ' "$path" | head -1 || true)"
    fail "$dockerfile does not use the pinned image ${key}" \
      "Expected a FROM line containing: FROM ${expected}" \
      "First FROM line found: ${found:-none}"
  else
    gate_ok "$dockerfile uses ${key}"
  fi
done

# --- image references must be digest-pinned -----------------------------
while read -r dockerfile; do
  while read -r line; do
    image="$(printf '%s' "$line" | awk '{print $2}')"
    [[ "$image" == "scratch" || "$image" == *scratch* ]] && continue
    if [[ "$image" != *"@sha256:"* ]]; then
      fail "$(basename "$(dirname "$dockerfile")")/Dockerfile uses a mutable image tag: ${image}" \
        "Pin by digest (image@sha256:...). A mutable tag makes the build irreproducible."
    fi
  done < <(grep -E '^FROM ' "$dockerfile" || true)
done < <(find "$ROOT" -name Dockerfile -not -path "*/node_modules/*")

# --- analyser pins must exist and be pinned the way their scripts expect --
TOOLS_LOCK="$ROOT/.github/ci/tools.lock.env"
if [[ ! -f "$TOOLS_LOCK" ]]; then
  fail ".github/ci/tools.lock.env is missing" "Restore it: CI installs its scanners from this file."
else
  # A Go tool must be pinned by module version; a container must be pinned by
  # digest. Checking each in its own shape catches a copy-paste between the two.
  for key in GOVULNCHECK_VERSION; do
    value="$(sed -n "s/^${key}=\([^ ]*\).*/\1/p" "$TOOLS_LOCK" | head -1)"
    if [[ -z "$value" ]]; then
      fail "${key} is not pinned in .github/ci/tools.lock.env" "Add '${key}=v1.2.3'."
    elif [[ "$value" != v* ]]; then
      fail "${key}='${value}' is not a Go module version" "Use a tags form such as v1.10.0; 'go install' needs it."
    else
      gate_ok "${key}: ${value}"
    fi
  done

  for key in GITLEAKS_IMAGE ACTIONLINT_IMAGE; do
    value="$(sed -n "s/^${key}=\([^ ]*\).*/\1/p" "$TOOLS_LOCK" | head -1)"
    if [[ -z "$value" ]]; then
      fail "${key} is not pinned in .github/ci/tools.lock.env" "Add '${key}=<registry>/<name>:<tag>@sha256:<digest>'."
    elif [[ "$value" != *"@sha256:"* ]]; then
      fail "${key}='${value}' is not digest-pinned" \
        "A mutable tag lets the analyser's ruleset change under a PR that was already green."
    else
      gate_ok "${key}: ${value%%@*}"
    fi
  done
fi

# --- the release allow-list must exist and be non-empty -------------------
# release.yml refuses to publish without it, so catching its absence here turns a
# confusing release failure into an obvious PR failure.
RELEASE_BRANCHES="$ROOT/.github/ci/release-branches.txt"
if [[ ! -f "$RELEASE_BRANCHES" ]]; then
  fail ".github/ci/release-branches.txt is missing" \
    "release.yml will refuse every release. List the branches cleared for publication."
elif ! grep -Evq '^[[:space:]]*(#|$)' "$RELEASE_BRANCHES"; then
  fail ".github/ci/release-branches.txt has no entries" \
    "With no cleared branches, no commit can ever be published."
else
  gate_ok "release branches: $(grep -Ev '^[[:space:]]*(#|$)' "$RELEASE_BRANCHES" | tr '\n' ' ')"
fi

if (( STATUS == 0 )); then
  gate_ok "All toolchain pins agree ($(gate_duration_since "$START"))"
fi

exit "$STATUS"
