#!/usr/bin/env bash
# Batched wrapper around scripts/ci/lib/filter-query.mjs.
#
# filter_query <filter-name>... reads paths on stdin and prints "<path>\t<hits>". One node
# process per Dockerfile rather than one per COPY line.
#
# Exits 2 when the matcher refuses a pattern, because "unsupported syntax" is not the same as
# "no match" and treating it as no-match would turn a config error into a silent gap.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "filter-query: node is required to evaluate path filters with the same semantics CI uses" >&2
  exit 2
fi

exec node "$here/filter-query.mjs" "$@"
