# Extending the gate

How to add a check, where each kind of check belongs, and which checks are
deliberately missing.

Read [security-baseline.md](security-baseline.md) first if the check you want is a
security check.

---

## The rule that decides where a check goes

> **A check that can be slow but must not be skipped belongs in the scheduled
> workflow. Speed is bought by moving work, not by dropping it.**

Concretely:

| Trigger | Budget | What belongs |
| --- | --- | --- |
| **PR** (`pr-quality-gate.yml`) | single-digit minutes for the whole gate | Anything that answers "may this merge?" — compile, lint, types, unit tests, lockfile advisories, new secrets. |
| **Scheduled** (`scheduled-checks.yml`) | tens of minutes | Anything needing a downloaded database, a warm cache, a cluster, a browser, or a full history. Image scans, SAST, E2E, accessibility, full-history secrets. |
| **On-demand** (`workflow_dispatch`) | as long as it takes | Long diagnostics a human explicitly wants now. |
| **Pre-release** | as long as it takes | Full E2E across a browser matrix, performance/load, migration rehearsal against a production-shaped database. |

**Why this split matters more than it looks.** If a 12-minute scan lives in the PR
gate, developers do not file a ticket saying "the gate is slow". They batch work into
larger PRs, they stop rebasing, and eventually someone with admin rights merges with a
red check "because it's just the image scan". You have then lost both the speed and the
check. Moving a slow check to a schedule keeps the PR gate trustworthy, which is the
only property a gate has.

---

## Adding a PR-blocking check (the recipe)

Every check in this repository follows the same shape. Do the same.

### 1. Write the check as a script, not as YAML

Put it in `scripts/` and make it work on a laptop:

```bash
scripts/check-<name>.sh
```

Start it with the bootstrap so `$ROOT` and the `gate_*` helpers are available:

```bash
#!/usr/bin/env bash
set -uo pipefail
# shellcheck source=scripts/lib/gate-bootstrap.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/gate-bootstrap.sh"

START=$(date +%s)
gate_step "Component · What this check does"

if ! some-tool --check; then
  gate_error "What failed" \
    "Reproduce locally: some-tool --check" \
    "Policy source: .ci/security-policies.env"
  exit 1
fi

gate_ok "What passed ($(gate_duration_since "$START"))"
```

The bootstrap exists because every script that computes its own repository root gets
to make its own off-by-one-directory mistake — which happened here, and produced
"gate_step: command not found" rather than anything helpful.

**Why a script and not inline YAML:** the check must be reproducible locally. A
developer who cannot run the check that failed will treat it as an opaque bot instead
of a bug to fix, and the gate becomes something that happens *to* them.

### 2. Make the failure message carry its own fix

`gate_error` prints a `::error::` annotation *and* `fix:` lines. Write the fix line as
the exact command to paste. This is the whole of requirement 7 — a CI failure that
names the local reproduction command turns "the bot is red" into a 30-second fix.

### 3. Give non-obvious logic its own tests

If a check parses tool output or computes a verdict, put the logic in a `.mjs` module
under `scripts/` and test it with `node --test`. The `ci-self-check` job runs
`node --test scripts/security/*.test.mjs`.

This is not ceremony: a bug in a triage script produces a **false green**, which is
strictly worse than a false red. `scripts/security/fixtures/` pins one real captured
tool output so a format change breaks a test instead of quietly disabling a check.

### 3b. Prove the check can detect anything at all

Tests of your own parsing logic still leave a gap: they assume the scanner produced
output. The failure they cannot see is the scanner, or its configuration, silently
detecting nothing — and **a scanner configured to see nothing passes every scan of a
repository that has nothing.**

The fix is a canary: plant a known-bad input in a throwaway location, run the real check
against it with the real config, and require detection.
`scripts/security/selftest-secrets.sh` is the worked example — a set of inert credentials
in a temporary git repository, asserting on the *rule id* that fired rather than on
"something fired", because a catch-all match would hide one specific rule having broken.
The set covers vendor token shapes *and* the rules this repository added itself, since the
default ruleset cannot vouch for the latter.

Three rules, each learned from a bug this caught:

- **Assert on identity, not presence.** "Some rule fired" is satisfiable by a widened
  allowlist plus a high-entropy catch-all. Require the specific rule id.
- **Never plant the canary in the repository itself.** It would live in history, and
  "rotate it, it is in the log now" applied to a fake credential teaches people that
  scanner alerts are noise.
- **Parse the report; do not grep it.** gitleaks pretty-prints its JSON
  (`"RuleID": "x"`, with a space), so a wrapper matching `"RuleID":"x"` reports a
  permanently clean scan. This project's own test harness hit exactly that bug before the
  production script did. Likewise a container must write its report to a host-mounted
  path, or the file simply is not there afterwards.

Total failure — nothing detected — blocks. A partial miss warns, because rule ids move
between tool releases and an unrelated PR should not be blocked on a Tuesday by one. But
update the canary list in the same PR, so the change is visible instead of becoming a
quietly widened allowlist.

The same pattern generalises: a vulnerability scanner that reports zero findings on a tree
containing a dependency with a known CVE is broken, and the check for that is a pinned
vulnerable fixture, which `scripts/security/fixtures/` already keeps for govulncheck.

### 4. Add it as its own step with a name that reads as a verdict

```yaml
      - name: "Component · What it checks"
        run: ./scripts/check-<name>.sh
```

One step per validation. If two validations share a step, one red step no longer tells
anyone which validation failed, and that is exactly what requirement 7 exists to
prevent.

### 5. Wire it into the aggregate gate

Add the job to `quality-gate`'s `needs:` list and add a `judge "..." "$RESULT"` line.
Forgetting this means the check runs but **does not block**, which is invisible: it
looks like a passing gate.

If the job can be skipped by a path filter, it *must* go through the aggregate — see
the comment block above the `quality-gate` job for why a skipped check silently
satisfies branch protection.

### 6. Add a path filter if it is component-scoped

Edit `.github/ci/paths-filter.yaml`. Then run
`./scripts/ci/verify-path-filters.sh`, which fails if a code directory has no filter or
a filter has no consumer. That check exists because the dangerous direction for change
detection is *silently running nothing*: an uncovered directory shows as "skipped", the
aggregate gate passes, and unvalidated code merges.

### 7. Document it

Add a row to the table in README.md and, if it has a threshold, to
security-baseline.md. A check nobody can find is a check nobody trusts when it fails.

---

## Adding a nightly check

Same recipe, into `scheduled-checks.yml`. Two differences that matter:

1. **Add it to `scheduled-verdict`'s `needs:` and its loop.** Otherwise it can go red
   and the run still reports green.
2. **Never use `continue-on-error`.** In the PR gate there is a case for it (collecting
   all failures at once). In a nightly, whose entire purpose is to be *seen* failing, it
   deletes the signal.

Branch protection cannot surface a scheduled failure — scheduled runs are not attached
to a PR. So the notification path is part of the check: enable Checks notifications, or
add a step that posts a failed run to the team channel.

---

## Checks that depend on architecture — deliberately absent

These are **not implemented**, because the right shape depends on decisions this POC
cannot make. Each has a reason and a path.

| Check | Why absent | Path to implementing |
| --- | --- | --- |
| **DB migrations** | No database in the POC. | CI must run migrations *forward from the previous release*, not just from empty — that is the case that breaks production. Needs a service container and a known "last released" schema. |
| **Integration tests** | Same. | Service containers (`postgres:`, `redis:`) in a nightly job. Keep them out of the PR gate unless they stay under ~60s. |
| **E2E** | No flows worth testing yet. | Playwright in a nightly + before-release. Needs a stable test-data story before it can be blocking; a flaky E2E test that blocks merges is worse than no E2E. |
| **Helm / Kubernetes manifests** | No charts. | `helm lint` + `helm template` + `kubeconform` are fast enough for the PR gate. `kubeescape`/`conftest` policy checks fit the nightly. |
| **Generated-code drift** | No generators. | Re-run the generator in CI and `git diff --exit-code`. Genuinely cheap, high value — first thing to add once any code is generated. |
| **DB permission checks** | No DB. | Needs a defined role model first. Test with a least-privilege role, not `postgres`. |
| **Accessibility** | One page. | `@axe-core/playwright` inside the E2E job. Blocking on `critical`/`serious` only, initially. |
| **Responsive / visual** | One page. | Screenshot diffing in a nightly. Note: visual baselines are inherently stateful and need an explicit "accept the new baseline" workflow, or they become noise. |
| **Licence scanning** | No approved-licence list exists — a **legal** decision. | Flip `license-check: true` in Dependency Review once a list exists; a denylist is a fine start. |
| **Mobile** | No mobile code. | Entirely separate pipeline; reuse only the aggregate-job pattern. |
| **Docs validation** | Low volume. | `lychee` for links (nightly — network-dependent, so blocking a PR on someone else's 404 is borrowing their outage) + a markdown linter (PR-safe). |
| **Arabic / RTL** | The POC has i18n strings but no layout. | Needs a real page with a real layout. RTL checks (logical CSS properties, no `left`/`right` hardcoding) are lintable and belong in the PR gate once there is CSS to lint. |
| **SAST (CodeQL)** | First-run cost, and findings need triage capacity before they can block. | Nightly `codeql-action`, non-blocking at first, promote to blocking once the existing findings are at zero. Never make SAST blocking on day one — it starts with a wall of findings and the result is that it gets removed. |
| **Container image scanning** | Scanner DB download dominates PR runtime. | Nightly, scanning the local build. Threshold already configured but unread — see security-baseline.md. |
| **Signed commits** | Needs a signing-infrastructure decision. | Ruleset → "Require signed commits", plus developer key setup. Blocks `main` pushes from machines that cannot sign, so it is a people decision first. |
| **Rootless nginx in `frontend/Dockerfile`** | The upstream image's master process runs as root. | Switch to `nginxinc/nginx-unprivileged:<tag>@sha256:...`, move the pid/temp paths under `/tmp` or `/var/cache/nginx`, and re-run the container smoke tests. Deliberately not done here as a side effect of a CI-focused change. |

---

## Known gaps and limitations

Honest list, because a POC that claims to be complete teaches nothing.

- **No reusable-workflow repository yet.** `rihal/quality-gate-poc` has one consumer,
  and the right abstraction is not visible from one example. Premature extraction
  produces a shared workflow with seven `if:` inputs that nobody can change without
  breaking three teams. Extract after a second repository adopts it — see below.
- **The npm dev-only graph is unenforced.** The weakest point in the current policy.
- **Backend has zero third-party dependencies by design**, so `go.sum`, module-graph
  growth and dependency-caching behaviour are all untested. Re-enable `cache: true` in
  setup-go in the same commit that adds the first real dependency.
- **No caching for Go** — correct today (nothing to cache), wrong the moment a
  dependency exists.
- **Multi-arch release builds are unverified against a real registry** (no registry
  configured), so `provenance: mode=max` and `sbom: true` are untested end to end. The
  single-arch PR builds *are* verified, including provenance build-args in both images.
- **`actionlint` does not evaluate `if:` expressions**, so a typo in a `needs.x.outputs.y`
  name is not caught statically. `verify-path-filters.sh` covers the specific case of an
  output that is never produced, which is the one that silently disables a job.
- **Timings in README.md are local measurements**, not CI-run measurements.

---

## Toward a company standard (recommendation, not policy)

The intended end state is a separate repository, e.g. `rihal-ci-workflows`, exposing
reusable workflows:

```yaml
jobs:
  quality-gate:
    uses: rihal/rihal-ci-workflows/.github/workflows/pr-quality-gate.yml@v1
    with:
      frontend_path: apps/web
      go_version: '1.26'
      npm_blocking_severity: 'moderate'
```

Aim at **standardising outcomes, not YAML**. The requirement is "every repository has
a required merge gate that runs lint, types, tests, build and a security baseline, and
names the failed validation". Two repositories achieving that with different YAML both
satisfy it. Requiring identical YAML guarantees the shared workflow gets forked the
first time it is inconvenient, and a forked workflow is not a standard.

Design constraints worth keeping when the extraction happens:

1. **Policy in data, not in the workflow.** Thresholds stay in a per-repo file that the
   reusable workflow reads, so teams tune without forking.
2. **Version the reusable workflow by tag, and consume it by SHA** — same supply-chain
   argument as action pinning.
3. **One escape hatch, loudly.** A repo that needs to deviate should set an input, not
   copy the workflow. An unused `if:` in a shared workflow is technical debt; a
   copied workflow is a lost standard.
4. **The ruleset ships with the workflow.** Commit exported ruleset YAML and a script
   to apply it. A pipeline without an enforced ruleset is a suggestion.
