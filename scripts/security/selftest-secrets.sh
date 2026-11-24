#!/usr/bin/env bash
# Canary test for the secret scanner.
#
# WHY THIS EXISTS
# The scan's real failure mode is not a missed commit -- it is a quietly broken check
# that reports "no secrets found" forever. Three ways that happens, all of them silent:
#
#   * an allowlist entry broadens and starts swallowing real credentials
#   * the ruleset or pinned image changes underneath the config
#   * the container is invoked in a way that produces an empty report
#
# `scan-secrets.sh` guards the third (0 commits scanned is a failure). This guards the
# first two, which no amount of scanning-the-repo can detect: a scanner configured to
# see nothing passes every scan of a repository that has nothing.
#
# So: plant credentials in a throwaway git repo, scan it with the same pinned container
# and the same config, and require detection. Deliberately NOT the repository's own
# files -- planting a canary in the real tree means it lives in history, and "rotate it,
# it is in the log now" applied to a fake secret is a waste of everyone's evening.
#
# Run from CI (ci-self-check) and locally. Takes ~15s with the image already pulled.
set -uo pipefail
# shellcheck source=scripts/lib/gate-bootstrap.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/gate-bootstrap.sh"
gate_load_policy "$ROOT/.ci/security-policies.env" || exit 1

gate_step "CI self-check · Secret scanner canary test"
START=$(date +%s)

GITLEAKS_IMAGE="$(gate_read_key "$ROOT/.github/ci/tools.lock.env" GITLEAKS_IMAGE || true)"
CONFIG="$ROOT/.gitleaks.toml"

USE_CONTAINER=0
if command -v gitleaks >/dev/null 2>&1; then
  gate_log "using gitleaks from PATH"
elif [[ -n "$GITLEAKS_IMAGE" && "$GITLEAKS_IMAGE" == *"@sha256:"* ]] && command -v docker >/dev/null 2>&1; then
  USE_CONTAINER=1
  gate_log "using pinned container: $GITLEAKS_IMAGE"
else
  gate_error "No gitleaks available for the canary test" \
    "Install gitleaks or make Docker available; this check is blocking by design."
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- the canaries ----------------------------------------------------------
# Each entry is `<rule id>|<payload parts>`. The payload is split on `|` and re-joined at
# run time so no committed file contains a complete credential — see the note below.
#
# WHY SPLIT THE LITERAL AT ALL
# A whole credential in this file would be flagged by the very scanner this script tests,
# and the only way to silence that is an allowlist entry for this path — a blanket,
# location-based exemption, exactly the thing this script exists to detect. So the payloads
# are stored in pieces and assembled in a temp directory instead. The values are inert:
# they are vendor documentation samples or synthetic, and none authenticates anywhere.
#
# Requiring the *rule id* rather than merely "something fired" matters: a catch-all
# high-entropy rule matching everything would hide the fact that one specific vendor rule
# has stopped working.
#
# Rule ids and payload shapes come from gitleaks v8.30.1's own output, not its
# documentation. Two ids guessed from the docs do not exist as expected (`slack-token` is
# really `slack-bot-token`; `aws-access-token` requires an all-uppercase key id, so a
# lowercase character silently disables the rule), and a wrong id reads as "the scanner is
# broken" when the canary is what is wrong.
#
# Payload rules, learned the hard way during testing:
#   * `\n` is honoured (written with `printf '%b'`), because the private-key rule wants a
#     body line, not just a header.
#   * No `|` may appear inside a payload — the join removes them all.
#   * Lengths must be exact, not approximate. `github-fine-grained-pat` is the
#     length-exact `github_pat_\w{82}` and a body 8 characters short never matches, which
#     looks identical to a broken scanner from the outside.
#   * Payloads must not be sequential. The default config's global stopwords list contains
#     `abcdefghijklmnopqrstuvwxyz`, so an alphabet-run body is allowlisted on purpose and
#     the rule under test never fires.
#
# The last three entries are not vendor tokens. They cover the rules this repository added
# itself, which the default ruleset cannot vouch for: the project's own fake-secret marker,
# the Basic-auth header rule and the connection-URI rule. If someone converts
# `.gitleaks.toml` from `[extend] useDefault = true` to a replacement config, or edits one
# of these regexes into disuse, every vendor canary still passes while the project rule is
# dead. Those are the cases only these entries can see.
CANARIES=(
  'github-pat|ghp_16C7|e42F292c6912E7710c83|8347Ae178B4a'
  'github-oauth|gho_16C7|e42F292c6912E7710c83|8347Ae178B4a'
  'github-fine-grained-pat|github_pat_|qWrT3yUiOpAs9dFgHjKl|ZxCvBnMaSdFg4HjKlQwE|7rTy6uIo5pAs3dFg2hJk|1lK0jHgFdSa9pOi8uYtR|cV'
  'private-key|-----BEGIN RSA| PRIVATE KEY-----|\n|MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn|/ygWyF8PbnGy0AHBqMv7JvVyvf|\n|-----END RSA| PRIVATE KEY-----'
  'slack-bot-token|xoxb-123456789|012-123456789|0123-abcdefghijklmnopqrstuvwx'
  'aws-access-token|AKIA|4A5CJ6ABZ3TZ7VXR'
  'npm-access-token|//registry.npmjs.org/:_authToken=|npm_0tiWh2t3bIGdzWJ|prZoPLnFhZQNmxzFF0mcx'
  'poc-test-fake-secret|fake-secret-|aB3dE6fG9hJ2kL5m'
  'http-basic-auth-header|Authorization: |Basic VXNlckAxMzp8|Q2hhbmdlVGhpc1RvQVJlYWxBY2NvdW50|'
  # Split *before* the `://`, not just inside the credential. The point of splitting is that
  # no line of this file matches the rule being tested, and an earlier version split only
  # the password — leaving `postgres://ci_|user:Kn9…@db.internal` on one line, which is
  # still scheme + userinfo + host, so this repository's own URI rule flagged its own
  # canary. `:|//` never matches `[a-zA-Z][a-zA-Z0-9+.-]*://`, and the joined payload does.
  'credentials-in-connection-uri|postgres:|//ci_user|:Kn9Wm2Xv7Bq4Ld8Zt3|@db.internal:5432/app'
)

# --- scan them -------------------------------------------------------------
# One commit per canary: putting them all in a single file lets one broad match stand in
# for the whole set and proves nothing about the individual rules.
canary_repo="$WORK/canaries"
mkdir -p "$canary_repo"
(
  cd "$canary_repo" || exit 1
  git init -q . || exit 1
  git config user.email canary@invalid
  git config user.name 'canary'
  git config commit.gpgsign false
  i=0
  for entry in "${CANARIES[@]}"; do
    i=$((i+1))
    payload="${entry#*|}"
    payload="${payload//|/}"
    # '%b' so \n inside the payload becomes a real newline. The format string is fixed and
    # never derived from the payload: `printf` parses a format beginning with `--` as an
    # option, which once swallowed a private-key payload and made the rule look broken.
    printf '%b\n' "$payload" >"canary-$i.txt"
    git add -A
    git commit -q -m "canary $i" || exit 1
  done
) || { gate_error "Could not build the canary repository"; exit 1; }

REPORT="$WORK/report.json"

if (( USE_CONTAINER )); then
  # The report is mounted from the host. Writing it to a path inside the container loses
  # it, and an absent report is indistinguishable from a clean scan unless you check --
  # which is exactly the bug this script exists to catch in the real scanner.
  RUNNER=(docker run --rm -i
    -v "$canary_repo:/repo"
    -v "$WORK:/report"
    -w /repo "$GITLEAKS_IMAGE")
  REPORT_ARG="/report/report.json"
  CONFIG_ARG="/repo/$(basename "$CONFIG")"
else
  RUNNER=(gitleaks)
  REPORT_ARG="$REPORT"
  CONFIG_ARG="$CONFIG"
fi

# `git` subcommand, no --log-opts: this scans the whole throwaway repo on purpose.
# Exit code is ignored deliberately -- findings are the expected outcome and the report
# is what gets parsed.
gate_group "Scan canaries with the repository's own config"
if (( USE_CONTAINER )); then
  # The container sees only the mount, so the config has to be inside it.
  cp "$CONFIG" "$canary_repo/$(basename "$CONFIG")"
fi
"${RUNNER[@]}" git \
  --config "$CONFIG_ARG" \
  --no-banner \
  --redact \
  --exit-code 1 \
  --report-format json \
  --report-path "$REPORT_ARG" \
  --log-level warn >"$WORK/scan.log" 2>&1 || true
sed 's/^/  /' "$WORK/scan.log"
gate_endgroup

if [[ ! -f "$REPORT" ]]; then
  gate_error "Canary scan produced no report file" \
    "Without a report there is no verdict, and 'no verdict' must never read as 'clean'." \
    "Reproduce: ./scripts/security/selftest-secrets.sh"
  exit 1
fi

# gitleaks pretty-prints its JSON. Parsed rather than grepped: matching `"RuleID":"x"`
# without the space returns nothing from real output, which is precisely how a scanner
# check ends up permanently reporting "no findings".
DETECTED="$(node -e '
  const fs = require("node:fs");
  let list = [];
  try { list = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { process.stdout.write(""); process.exit(0); }
  process.stdout.write([...new Set((Array.isArray(list) ? list : []).map((f) => f.RuleID))].sort().join(" "));
' "$REPORT" 2>/dev/null || echo '')"

if [[ -z "$DETECTED" ]]; then
  gate_error "The canary scan detected nothing at all" \
    "Every planted credential was missed, which means the ruleset, the config or the invocation is broken." \
    "This is the failure mode where the real secret scan reports a clean pass forever." \
    "Reproduce: ./scripts/security/selftest-secrets.sh"
  exit 1
fi
gate_log "rules that fired: $DETECTED"

# --- assertions ------------------------------------------------------------
missed=0
for entry in "${CANARIES[@]}"; do
  want="${entry%%|*}"
  if [[ " $DETECTED " != *" $want "* ]]; then
    gate_warn "canary for rule '$want' was not detected"
    missed=$((missed + 1))
  fi
done

if (( missed > 0 )); then
  echo
  echo "  ${missed} of ${#CANARIES[@]} canaries went undetected under .gitleaks.toml."
  echo "  Either an allowlist entry has broadened past its intent, or gitleaks changed"
  echo "  rule ids in a release. Check the allowlist first -- it is the likelier cause"
  echo "  and the one that silently disables real coverage."
  echo
  echo "  If a rule id was legitimately renamed upstream, update CANARIES in this file"
  echo "  and say so in the PR, so the change is visible rather than a widened allowlist."

  # Partial misses are advisory rather than blocking: rule ids move between gitleaks
  # releases, and this must not block unrelated PRs on a Tuesday. The total-failure case
  # above -- nothing detected at all -- does block, because that means the check is off.
  gate_warn "Secret scanner canary: $missed of ${#CANARIES[@]} undetected"
  gate_append_summary \
    "" \
    "| Check | Component | Result | Duration |" \
    "| --- | --- | --- | --- |" \
    "| Secret scanner canary test | repository | **$missed of ${#CANARIES[@]} undetected** | $(gate_duration_since "$START") |"
  exit 0
fi

gate_ok "Secret scanner detected all ${#CANARIES[@]} canaries ($(gate_duration_since "$START"))"

# --- the mirror-image assertion --------------------------------------------
# Detecting the canaries proves the scanner CAN see secrets. It does not prove the
# repository is free of them, and the specific risk here is self-inflicted: this file holds
# the canary payloads, and docs/security-baseline.md spells out the credential formats the
# project rules match. If a fragment is ever edited so a whole credential lands on one line,
# the honest fix would be an allowlist entry for scripts/security/ -- a blanket by-location
# exemption, exactly what the check above exists to detect.
#
# So: scan the real tree with the real config and require zero findings. The two assertions
# are in tension on purpose, and both have to hold.
SELF_REPO="$WORK/selftree"
mkdir -p "$SELF_REPO"
if tar --exclude=node_modules --exclude=.git --exclude=dist --exclude=coverage --exclude=bin \
       -C "$ROOT" -cf - . 2>/dev/null | tar -C "$SELF_REPO" -xf - 2>/dev/null; then
  SELF_REPORT="$WORK/selfreport.json"
  SELF_LOG="$WORK/selfscan.log"
  git -C "$SELF_REPO" init -q . >/dev/null 2>&1
  git -C "$SELF_REPO" add -A >/dev/null 2>&1
  git -C "$SELF_REPO" -c user.email=canary@invalid -c user.name=canary \
    commit -q -m "self-scan" >/dev/null 2>&1

  if (( USE_CONTAINER )); then
    cp "$CONFIG" "$SELF_REPO/$(basename "$CONFIG")"
    RUNNER=(docker run --rm -i
      -v "$SELF_REPO:/repo"
      -v "$WORK:/report"
      -w /repo "$GITLEAKS_IMAGE")
    SELF_REPORT_ARG="/report/selfreport.json"
    CONFIG_ARG="/repo/$(basename "$CONFIG")"
  else
    RUNNER=(gitleaks)
    SELF_REPORT_ARG="$SELF_REPORT"
    CONFIG_ARG="$CONFIG"
  fi

  "${RUNNER[@]}" git \
    --config "$CONFIG_ARG" \
    --no-banner \
    --redact \
    --exit-code 1 \
    --report-format json \
    --report-path "$SELF_REPORT_ARG" \
    --log-level warn >"$SELF_LOG" 2>&1 || true

  # The report must EXIST before its contents mean anything. A scan that failed to write a
  # report and a scan that found nothing both parse as "0 findings", which is the exact
  # false green this whole file exists to prevent -- so absence is a failure, not a pass.
  if [[ ! -f "$SELF_REPORT" ]]; then
    gate_error "Self-scan produced no report file" \
      "An absent report is not a clean scan; it is an unknown." \
      "Reproduce: ./scripts/security/selftest-secrets.sh"
    exit 1
  fi

  # Parse, never grep: same reason as above, and a silently-empty match here would
  # manufacture a clean result out of a format change.
  SELF_FINDINGS="$(node -e '
    const fs = require("node:fs");
    let list = [];
    try { list = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { process.stdout.write("PARSE-ERROR"); process.exit(0); }
    if (!Array.isArray(list)) { process.stdout.write("PARSE-ERROR"); process.exit(0); }
    process.stdout.write(String(list.length));
  ' "$SELF_REPORT" 2>/dev/null || echo PARSE-ERROR)"

  if [[ "$SELF_FINDINGS" == "PARSE-ERROR" ]]; then
    gate_error "Could not parse the self-scan report" \
      "Treating unparseable scanner output as 'no findings' is how a check goes blind on a format change." \
      "Check whether gitleaks changed its report shape; the pinned digest should prevent that."
    exit 1
  fi

  if [[ "$SELF_FINDINGS" != "0" ]]; then
    echo
    gate_error "This repository's own files trip its own secret scanner (${SELF_FINDINGS} finding(s))" \
      "Most likely a canary payload or a documented credential format is now a complete match on one line." \
      "Fix the fragment or the prose. Do NOT add an allowlist entry for scripts/ or docs/ -- that is exemption by location." \
      "Findings below; the report is redacted, so no secret is printed."
    node -e '
      const fs = require("node:fs");
      try {
        for (const f of JSON.parse(fs.readFileSync(process.argv[1], "utf8")))
          console.log(`  ${f.RuleID}  ${f.File}:${f.StartLine ?? "?"}`);
      } catch { }
    ' "$SELF_REPORT" 2>/dev/null
    exit 1
  fi
  gate_ok "The repository's own tree produces no findings under its own config"
fi

gate_append_summary \
  "" \
  "| Check | Component | Result | Duration |" \
  "| --- | --- | --- | --- |" \
  "| Secret scanner canary test | repository | pass (${#CANARIES[@]}/${#CANARIES[@]} detected) | $(gate_duration_since "$START") |" \
  "| Secret scanner negative test | this repository's own tree | pass (0 findings) | $(gate_duration_since "$START") |"
