# quality-gate-ci-poc

A small proof-of-concept for a **standardised CI quality gate**: one required status
check that blocks a merge, tells you exactly which validation failed, publishes nothing,
and runs only the parts relevant to the change.

The sample application is intentionally tiny and stays out of the way. Everything of
interest here is in `.github/`, `scripts/`, `.ci/` and `docs/`. The purpose is to settle
the *shape* of a pipeline before it is copied across Rihal repositories — not to
demonstrate application architecture.

> **Status: proof of concept.** Every threshold, tool choice and policy in this
> repository is an **assumption and recommendation**, not agreed company policy. The
> open decisions the team still owns are collected in
> [§14 Assumptions and open decisions](#14-assumptions-and-open-decisions).

---

## Table of contents

1. [What the gate does](#1-what-the-gate-does)
2. [Quick start](#2-quick-start)
3. [The ten requirements](#3-the-ten-requirements)
4. [Requirement → job → step matrix](#4-requirement--job--step-matrix)
5. [The three workflows](#5-the-three-workflows)
6. [How to test each stage](#6-how-to-test-each-stage)
7. [Change-aware execution](#7-change-aware-execution)
8. [The required check, and why there is only one](#8-the-required-check-and-why-there-is-only-one)
9. [Security baseline in one table](#9-security-baseline-in-one-table)
10. [Failure playbook — eight scenarios](#10-failure-playbook--eight-scenarios)
11. [Success criteria and measured baseline](#11-success-criteria-and-measured-baseline)
12. [Coverage matrix — what is and is not validated](#12-coverage-matrix--what-is-and-is-not-validated)
13. [Checks that depend on architecture — not implemented](#13-checks-that-depend-on-architecture--not-implemented)
14. [Assumptions and open decisions](#14-assumptions-and-open-decisions)
15. [Repository layout](#15-repository-layout)

---

## 1. What the gate does

On a pull request, `quality-gate / required` answers one question: **may this merge?**

```
                        ┌─ Frontend Quality ──────── lint · types · tests · build
Detect changed          │  Backend Quality ───────── fmt · vet · tests · build
components ──┬──────────┤  Security · vulnerabilities ─ npm audit · govulncheck
             │          │  Security · dependency review ─ only what this PR adds
             │          │  Security · secret scan ──── gitleaks over PR commits
             │          │  Docker verification ─────── build both images, push=false
             │          └─ CI self-check ───────────── pins · filters · actionlint
             ▼
     quality-gate / required  ← the only check branch protection needs
```

Nine jobs, one verdict. A component that did not change is *skipped*, and the aggregate
reports it as "not applicable" rather than as a pass — so the summary never claims
coverage that did not happen.

**Design principles**, in the order they were prioritised:

| Principle | What it means in practice |
| --- | --- |
| **Standardise outcomes, not YAML** | The requirement is "every repo has a required gate running lint, types, tests, build and a security baseline, and it names the failed validation". Two repos with different YAML both satisfy that. Identical YAML gets forked the first time it is inconvenient. |
| **PR CI stays fast** | Anything needing a downloaded database, a browser or a cluster goes to the scheduled workflow. Slow checks are *moved*, never dropped. |
| **Validation and deployment are separate** | PR CI builds images with `push: false`. Only `release.yml` can publish. |
| **Feedback must be actionable** | Every failing step prints the exact command to reproduce it locally. One validation per step, so the check name says *which* validation failed. |
| **A scan that did not run is never a clean scan** | Empty scanner output, a zero-commit range and an unparsable report all fail the build rather than reporting success. |
| **Structure for reuse, do not extract yet** | One consumer cannot reveal the right abstraction. See [docs/extending-the-gate.md](docs/extending-the-gate.md). |

---

## 2. Quick start

Everything CI runs is runnable locally — that is a deliberate requirement, not a
coincidence. A check you cannot run is a check you will treat as an opaque bot.

**Prerequisites:** Node.js and Go at the versions in `.tool-versions`, plus Docker.
`mise install`, `asdf install` or a manual install all work; the versions are pinned in
one file, and `scripts/ci/verify-toolchain-sync.sh` fails the build when any other
config file disagrees with it.

```bash
# Everything for both components
./scripts/check-frontend.sh all
./scripts/check-backend.sh all

# Or one validation at a time — same granularity CI uses, same named output
./scripts/check-frontend.sh typecheck
./scripts/check-backend.sh vet

# Security baseline
./scripts/security/scan-frontend-deps.sh
./scripts/security/scan-backend-deps.sh
./scripts/security/scan-secrets.sh

# The pipeline's own self-checks
./scripts/ci/verify-toolchain-sync.sh
./scripts/ci/verify-path-filters.sh
./scripts/ci/lint-workflows.sh          # actionlint, in a pinned container
./scripts/security/selftest-secrets.sh  # proves the secret scanner still detects things
node --test scripts/security/*.test.mjs # the gate's triage logic has its own tests

# Run the containers the way CI builds them
WEB_PORT=4080 API_PORT=4081 docker compose up --build
open http://localhost:4080
```

`check-*.sh all` reports `overall: pending` rather than `pass`. A local run does not
perform the security scans, container verification or dependency review that the CI gate
does, so claiming success from a laptop would be a false claim. Nothing here prints a
greener result than what it actually verified.

---

## 3. The ten requirements

| # | Requirement | How it is satisfied | Where |
| --- | --- | --- | --- |
| 1 | **Build validation** | `vite build` and `go build` run as their own named steps, on every PR touching that component. Both images are also built from the real Dockerfiles. | `frontend-quality`, `backend-quality`, `docker-verify-*` |
| 2 | **Linting** | ESLint 9 flat config (`eslint .`); `gofmt -l` and `go vet` for Go. | same jobs, one step each |
| 3 | **Type checking** | `tsc --noEmit` for TypeScript. Go is *statically compiled*, so a separate type-check step would be theatre — `go build` **is** the type check, and it is a named step. Not forced where N/A. | `frontend-quality` / `backend-quality` |
| 4 | **Unit tests** | Vitest (40 tests, `node` environment — no jsdom, no flakiness); `go test ./...` with `-count=1` to defeat the test cache. | same jobs |
| 5 | **Change-aware execution** | `dorny/paths-filter` against `.github/ci/paths-filter.yaml`; each component job has an `if:` on its filter output. | `detect-changes` |
| 6 | **No publishing from PR CI** | Every PR build sets `push: false`. The workflow's top-level `permissions:` has no write access of any kind. Publishing exists only in `release.yml`, in the single job holding registry credentials. | all PR jobs / `release.yml` |
| 7 | **Clear, actionable failure feedback** | One validation per step, so the Checks tab reads `Frontend Quality › Type check (tsc --noEmit)`. Failures emit `::error::` annotations plus `fix:` lines containing the exact local command. The aggregate job prints a per-check verdict table. | every job |
| 8 | **Security baseline** | npm audit (prod/dev split), govulncheck (reachability-based), dependency review (PR-introduced only), gitleaks (PR commits). Every threshold in one file. | `security-*` jobs |
| 9 | **Least-privilege `permissions:`** | `contents: read` at workflow level in all three workflows. Only `release.yml`'s `publish-image` job escalates (`packages: write`, `id-token: write`). | all workflows |
| 10 | **Release traceability** | Every published image gets an unconditional full-commit-SHA tag plus version tags; SHA and version are compiled into the Go binary and the JS bundle; SLSA provenance and SBOM attached on push. | `release.yml` |

---

## 4. Requirement → job → step matrix

Read this table as "if job X is red, requirement Y is what broke".

| Job (Checks-tab name) | Runs when | Steps, in order | Requirements |
| --- | --- | --- | --- |
| `Detect changed components` | always | Evaluate path filters → Record docs-only → Publish the decision | 5 |
| `Frontend Quality` | `frontend` or `shared` | Install (`npm ci` + lockfile-unchanged check) → **Lint (eslint)** → **Type check (tsc --noEmit)** → **Unit tests + coverage (vitest)** → **Build validation (vite build)** | 1 2 3 4 5 7 |
| `Backend Quality` | `backend` or `shared` | **Format check (gofmt)** → **Static analysis (go vet)** → **Unit tests (go test)** → **Build validation (go build)** | 1 2 3 4 5 7 |
| `Security · Dependency vulnerabilities` | any component | Show the applied policy → **Frontend · npm dependency audit** → **Backend · govulncheck (call-graph aware)** | 8 |
| `Security · Dependency review` | non-draft PRs | **Block newly introduced HIGH/CRITICAL runtime vulnerabilities** | 8 |
| `Security · Secret leak scan` | always | **Scan the pull request's commits for secrets (gitleaks)** | 8 |
| `Docker verification · backend` | `backend_docker` | **Build backend image (push disabled)** → **Assert: image built locally and nothing was pushed** | 1 6 |
| `Docker verification · frontend` | `frontend_docker` | **Build frontend image (push disabled)** → **Assert: image built locally and nothing was pushed** | 1 6 |
| `CI self-check` | always | Pins agree → Path filters cover everything → **Lint the workflow definitions (actionlint)** → **Run the gate scripts' own tests** → **Canary-test the secret scanner** | 7 (meta) |
| **`quality-gate / required`** | **always** (`if: always()`) | Aggregate applicable checks into one merge verdict | all — this is the merge gate |

`CI self-check` exists because a pipeline that validates application code but not itself
rots. It caught real bugs while this POC was built: a `paths-filter` entry that no job
consumed (silently running nothing), a drift between a Dockerfile's `COPY` and its path
filter, and a helper that broke on values containing `/`.

---

## 5. The three workflows

| File | Trigger | Publishes | Purpose |
| --- | --- | --- | --- |
| [`.github/workflows/pr-quality-gate.yml`](.github/workflows/pr-quality-gate.yml) | `pull_request` targeting `main` | **never** | The merge gate. Produces the `required` job check. |
| [`.github/workflows/release.yml`](.github/workflows/release.yml) | semver tag, push to `main`, `workflow_dispatch` | only if registry secrets exist | Validate → build multi-arch → publish with provenance, SBOM and SHA tags. |
| [`.github/workflows/scheduled-checks.yml`](.github/workflows/scheduled-checks.yml) | nightly `17 3 * * *`, `workflow_dispatch` | never | Slow-but-necessary checks: full-history secret scan, current-state dependency scans against fresh advisory data, toolchain currency. |

**Why the split is by trigger, not by tool.** A check's cost and its urgency are
different properties. A full-history secret scan is important and slow; blocking a
30-second PR on it buys nothing, because the secret is already pushed by the time the PR
opens. Moving it to a nightly keeps the PR gate fast *and* keeps the check. See
[docs/extending-the-gate.md](docs/extending-the-gate.md#the-rule-that-decides-where-a-check-goes).

### Release publishing is currently off, and that is by design

`release.yml` probes `CI_REGISTRY`, `CI_REGISTRY_USERNAME` and `CI_REGISTRY_PASSWORD` at
run time. With any missing, every validation and the full multi-architecture build still
run, and only the push is skipped — reported plainly in the job summary. Adding the
secrets enables publishing **without editing the YAML**, which is the point: a commented-out
publish step is how re-enabling it becomes an unreviewed change. Details in
[docs/releasing.md](docs/releasing.md).

---

## 6. How to test each stage

For each stage: what it does, why, which requirement it serves, how to make it fail, and
what you should see on GitHub. Full commands for all eight scenarios are in
[§10](#10-failure-playbook--eight-scenarios).

### Detect changed components
- **What:** evaluates `.github/ci/paths-filter.yaml` against the PR's changed files and publishes six boolean outputs.
- **Why:** running every gate on every PR is the fastest way to get a pipeline nobody waits for.
- **Requirement:** 5.
- **Test:** change one file under `frontend/` only.
- **Expected:** the job summary's "Change detection" table says Frontend = yes, Backend = no — skipped; `Backend Quality` shows a grey skip icon; `quality-gate / required` reports Backend as "not applicable / skipped (no relevant change)" — **not** as pass.

### Frontend Quality
- **What:** `npm ci`, then lint, type check, unit tests and build as four separate steps.
- **Why:** four validations in one step would report "failed" instead of *which* validation failed. Order is deliberate — lint and types are where most mistakes happen and cost under a second.
- **Requirements:** 1 2 3 4 5 7.
- **Test:** add `export const X: number = "not a number"` to a file in `frontend/src/lib/`.
- **Expected:** ✗ on `Frontend Quality`; the failing step is **Type check (tsc --noEmit)**; an annotation with the file and line, and a `fix:` line giving `./scripts/check-frontend.sh typecheck`; `quality-gate / required` is also ✗.

### Backend Quality
- **What:** `gofmt -l`, `go vet`, `go test -count=1 ./...`, `go build`.
- **Why:** Go has no separate type checker — `go build` *is* the type check. Making one up would be a step that always agrees with `go build`.
- **Requirements:** 1 2 3 4 5 7.
- **Test:** remove one tab of indentation from a function body in `backend/internal/gate/gate.go`.
- **Expected:** ✗ on `Backend Quality` at the **Format check (gofmt)** step, before tests run. `gofmt -l .` prints the offending file names in the annotation.

### Security · Dependency vulnerabilities
- **What:** npm audit over both the production and full dependency graphs, plus govulncheck with call-graph reachability analysis.
- **Why:** these are the two ecosystems' first-party scanners, so there is no third scanner to trust, and neither needs to download a vulnerability database — both query the advisory APIs directly, which keeps them at seconds, not minutes.
- **Requirement:** 8.
- **Test:** add a known-vulnerable dependency to `frontend/package.json`, or set `NPM_BLOCKING_SEVERITY_DEV=moderate` in `.ci/security-policies.env` and commit it.
- **Expected:** ✗ at **Frontend · npm dependency audit**, with the offending package, severity and advisory link listed, and the applied thresholds echoed first so the reader can see which policy produced the verdict.

### Security · Dependency review
- **What:** GitHub's own review of dependencies *this PR adds*, blocking HIGH and above in runtime scope.
- **Why:** the two audits above judge the repository as it currently stands. A vulnerability already on `main` keeps every subsequent PR red — correct for the nightly, useless to a reviewer. This answers the narrower, actionable question: *does this change introduce it?*
- **Requirement:** 8.
- **Test:** add any new runtime dependency; the check reports the diff of lockfile changes.
- **Expected:** a comment summary on the PR listing added dependencies, and ✗ only if one carries a HIGH+ runtime advisory.

### Security · Secret leak scan
- **What:** gitleaks over the commits introduced by the PR, using this repo's `.gitleaks.toml`.
- **Why:** a secret is compromised the moment it is pushed. It cannot be deferred to a nightly. Scanning *commits* and not the working tree matters: a credential added in commit 3 and deleted in commit 5 is invisible to a file scan and permanently present in the history everyone clones.
- **Requirement:** 8.
- **Test:** commit a file containing `AWS_SECRET_ACCESS_KEY = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`.
- **Expected:** ✗ with the file, line and rule name — the value itself redacted. Then treat it as compromised and **rotate before removing the line**.

### Docker verification (both images)
- **What:** builds each real Dockerfile with BuildKit, `push: false`, `load: true`, then asserts the image exists locally **and** that no registry credentials were present in the job.
- **Why:** `vite build` passing does not mean the image works. Two container bugs were found only by running the built images: nginx resolving `proxy_pass http://backend:8080` at config load (so the frontend container exited whenever the backend was absent), and a build-time provenance value that never reached the bundle.
- **Requirements:** 1 6.
- **Test:** append `FROM this-image-does-not-exist:no-such-tag` to `backend/Dockerfile`.
- **Expected:** ✗ at **Build backend image (push disabled)** with BuildKit's own layer-level error; `quality-gate / required` red.

### CI self-check
- **What:** proves the pipeline is internally consistent — pins agree across four files, path filters cover every component and every `COPY`ed file, workflows pass actionlint, the gate's triage logic passes its own tests, and the secret scanner still detects planted credentials.
- **Why:** a gate that validates application code but not itself rots silently. A filter whose consumer was renamed runs nothing and reports nothing.
- **Requirement:** 7, applied to the pipeline.
- **Test:** delete the `nginx.conf.template` line from `.github/ci/paths-filter.yaml`.
- **Expected:** ✗ at **Verify path filters cover every component and required file**, naming the file, the filter it fell out of, and the consequence: *"A change to frontend/nginx.conf.template would skip 'frontend_docker' — the only job that builds and runs the image."*
- **The canary step is the unusual one.** Every other check in the gate could be silently broken — an allowlist that widened, a rule id that moved, a container writing its report somewhere nobody reads — and still report a clean pass. `selftest-secrets.sh` plants inert credentials in a throwaway repo and requires the specific rule ids to fire. See [docs/security-baseline.md](docs/security-baseline.md#proving-the-scanner-still-works-scriptsisecurityselftest-secrets.sh).
- **It then asserts the opposite**, and both are needed: the repository's own tracked tree must produce *zero* findings under its own config. The canary payloads live in a committed file, so if one ever becomes a complete match on a single line, the tempting fix is an allowlist entry for `scripts/security/` — a by-location exemption that disables the check. That is not hypothetical: an earlier version of the connection-URI canary tripped the rule it was testing, and this assertion is what found it.

### quality-gate / required
- **What:** always runs; reports each upstream job as `applicable/pass`, `applicable/FAIL`, or `not applicable/skipped`, and exits non-zero if any *applicable* check failed.
- **Why:** see [§8](#8-the-required-check-and-why-there-is-only-one). It is the only check that cannot be satisfied by a job that never ran.
- **Requirements:** all — this is where they become enforceable.
- **Test:** any scenario in [§10](#10-failure-playbook--eight-scenarios).
- **Expected:** a "Quality gate verdict" table, then **Merge gate: FAIL for commit `abc1234`**.

### release.yml
- **What:** validates the tag, authorises the commit, re-runs the whole gate over the exact released commit, builds `linux/amd64` + `linux/arm64`, publishes with provenance and SBOM when credentials exist.
- **Why:** keeping validation and publishing in separate workflows means "green" and "published" are never confused for each other.
- **Requirements:** 6 9 10.
- **Test:** `git tag -a v0.1.0 -m 'POC release' && git push origin v0.1.0`
- **Expected:** all four jobs green; **Publish image** reports *publishing skipped — `CI_REGISTRY` is not configured*; the release summary lists the commit, the tag list it *would* have pushed, and the run link. With secrets configured, the same run pushes and prints digests.

---

## 7. Change-aware execution

`.github/ci/paths-filter.yaml` defines six filters. Every job's `if:` reads one.

| Filter | Patterns | Gates |
| --- | --- | --- |
| `frontend` | `frontend/**` | `Frontend Quality` |
| `backend` | `backend/**` | `Backend Quality` |
| `shared` | the three workflow files, `.github/ci/**`, `.ci/**`, `scripts/**`, `.tool-versions`, `.editorconfig`, `.gitignore` | both quality jobs and the security job |
| `frontend_docker` | `frontend/**`, minus `dist`, `coverage`, `node_modules`, `*.md` | `Docker verification · frontend` |
| `backend_docker` | `backend/**`, minus `bin`, `*.md` | `Docker verification · backend` |
| `docs` | `README.md`, `docs/**`, `.github/pull_request_template.md` | nothing — used only to compute `docs_only` |

Component filters are deliberately whole-directory rather than a list of "important"
subdirectories. A list of the first kind goes stale the day someone adds a directory, and
the failure mode is silent: the file changes, no filter matches, the job is skipped, the
aggregate passes. `verify-path-filters.sh` exists to make that class of mistake a build
failure instead of a rumour.

`frontend_docker` is near-identical to `frontend` today, and that is an honest limitation
rather than a clever optimisation — see the comment block in the filter file for why the
distinction is kept anyway.

Three things that are easy to get wrong and are handled explicitly:

**`shared` forces both components.** A `.tool-versions` bump can break either build, and
"only the frontend changed" is a conclusion about the diff, not about the effect. When the
pin changes, everything runs.

**The docker filters mirror the build context, deliberately.** Both Dockerfiles contain
`COPY . .`, so every file surviving `.dockerignore` is part of the image. A hand-maintained
list of "files that matter" is provably incomplete — and this exact drift happened here:
`nginx.conf.template` was `COPY`ed but missing from the filter, so a change that made the
container fail at startup would have skipped the only job able to detect it. So
`verify-path-filters.sh` now extracts every `COPY`/`ADD` source from every Dockerfile and
fails if the filter cannot see it.

**Uncovered directories are a build failure.** `verify-path-filters.sh` asserts every code
directory has a filter and every filter has a consumer. The dangerous direction for change
detection is *silently running nothing*: an uncovered file shows as "skipped", the aggregate
passes, and unvalidated code merges.

---

## 8. The required check, and why there is only one

Require **exactly one** status check in branch protection:

```
quality-gate / required
```

A job whose `if:` is false is reported as **skipped**, and GitHub counts a skipped check
as **satisfying** branch protection. So requiring `Frontend Quality` directly creates a
gate that passes when it should fail:

1. A backend-only PR opens. `frontend=false`.
2. `Frontend Quality` is skipped.
3. GitHub sees that requirement as satisfied — **by a check that never ran**.
4. The backend check goes red, but the requirement list looks satisfied, and someone merges.

The aggregate job always runs (`if: always()`), and its verdict is the conjunction of only
the checks that were *applicable*. Skipped upstream jobs become an input it reasons about
instead of a loophole.

Two consequences worth internalising:

- **`if: always()` is load-bearing.** If someone refactors the workflow and drops it, GitHub
  skips the aggregate whenever a dependency fails — turning a red gate into a *skipped*
  gate, which satisfies the requirement. `verify-path-filters.sh` greps for it and fails the
  PR if it is missing, so this cannot regress silently.
- **Any new check must be wired into the aggregate.** A check that runs but is not in
  `quality-gate`'s `needs:` and `judge` list does **not** block, and looks exactly like a
  passing gate. The PR template has a checkbox for it.

The full configuration — ruleset settings, why "Add checks" needs the check to have run
once, and three tests that prove protection actually blocks — is in
[docs/github-branch-protection.md](docs/github-branch-protection.md).

---

## 9. Security baseline in one table

Full detail, rationale and the list of open decisions:
[docs/security-baseline.md](docs/security-baseline.md).

| Check | Scope | Blocks on | Trigger |
| --- | --- | --- | --- |
| npm audit | frontend lockfile | `critical,high` in the **production** graph | PR + nightly |
| npm audit (dev-only graph) | frontend | reported, **not blocking** | PR + nightly |
| govulncheck | backend, call-graph aware | any **reachable third-party** finding | PR + nightly |
| govulncheck (stdlib) | Go standard library | reported as a warning | PR + nightly |
| Dependency Review | only dependencies this PR adds | `high`, runtime scope | PR |
| gitleaks | commits introduced by the PR | any finding | PR |
| gitleaks (full history) | every commit | any finding | nightly |
| gitleaks, project rules | connection URIs and Basic-auth headers, which the 222 default rules do not cover | any finding | PR |
| **canary test of the scanner itself** | inert planted credentials | nothing detected = fail | PR |
| Container image scan | built images | `HIGH` — **configured, not implemented** | — |

Every threshold lives in [`.ci/security-policies.env`](.ci/security-policies.env) and
nowhere else. Changing a policy is a one-line diff that appears in a PR review, instead of
a search through three YAML files for a hardcoded `--audit-level=high`.

Two decisions that will look surprising, both explained at length in the linked doc:

- **Go is gated on reachability, not severity.** Every OSV record observed in this repo's
  govulncheck output carried `severity: NONE`, so a CVSS threshold would be theatre.
  Reachability is the honest signal — and on this backend it separates 243 findings from 9.
- **Reachable standard-library findings are non-blocking.** They are fixed by bumping the
  pinned Go toolchain, not by the author of the unrelated feature PR in front of you.
  Blocking them stalls the queue and punishes the wrong person.
  `GO_BLOCK_ON_STDLIB_FINDINGS=true` changes that — the team still owes a decision on who
  owns "bump the toolchain".

---

## 10. Failure playbook — eight scenarios

Each scenario is one failure mode, how to trigger it, and what should happen. A gate that
only ever passes proves nothing, so **all eight were executed against these scripts**
during this POC, and every one failed as described.

Use a scratch branch. Clean up with
`git checkout main && git branch -D <branch> && git push origin --delete <branch>`.

### S1 — Lint failure
```bash
git switch -c scenario/lint main
# `export const UNUSED_SCENARIO: string = "x"` looks like the obvious choice and does NOT
# fail: an exported binding is not an "unused var", and there is no no-unused-exports rule.
# Push that and CI goes green -- worse than a broken check, because it looks like the gate
# cannot catch anything. Use a rule that is actually 'error' in frontend/eslint.config.js.
printf 'export function scenarioEqeq(a: string, b: string): boolean {\n  const touched = a == b\n  return touched\n}\n' >frontend/src/scenario-lint.ts
git add frontend/src/scenario-lint.ts
git commit -m 'test: break lint' && git push -u origin HEAD
```
**Expected:** ✗ `Frontend Quality` at step **Lint (eslint)** — the *first* step, so the
failure appears within seconds of the runner starting. The annotation names the rule id
(`eqeqeq`) and the line. `fix:` line: `./scripts/check-frontend.sh lint`. ✗
`quality-gate / required`. `Backend Quality` skipped.

### S2 — Type-check failure
```bash
git checkout -b scenario/types main
printf 'export const SCENARIO_TYPE: number = "not a number"\n' >frontend/src/scenario-types.ts
git add frontend/src/scenario-types.ts
git commit -m 'test: break typecheck' && git push -u origin HEAD
```
**Expected:** ✗ at **Type check (tsc --noEmit)**, with **Lint passing immediately before
it**. That ordering is the demonstration, not an oversight: `frontend/eslint.config.js` is
deliberately *not* type-aware (no `projectService`), so ESLint cannot see that `number ≠
string` and correctly reports nothing. Type correctness is `tsc`'s job; the checks do not
overlap, and the check name alone tells a reader which validation failed.

The earlier draft of this section claimed the opposite — that this file "also breaks lint"
and that you needed a contrived `Record<string, number>` to isolate types. It does not, and
you do not. Making ESLint type-aware would double the frontend job's runtime to report the
same error twice.

### S3 — Unit test failure
```bash
git checkout -b scenario/test main
printf 'import { describe, expect, it } from "vitest"\ndescribe("scenario", () => { it("fails", () => { expect(1).toBe(2) }) })\n' > frontend/tests/scenario.test.ts
git add frontend/tests/scenario.test.ts
git commit -m 'test: add a failing test' && git push -u origin HEAD
```
**Expected:** ✗ at **Unit tests (vitest)**, after lint and type check passed. Vitest prints
the assertion diff; the `-count=1` equivalent on the Go side (`go test -count=1 ./...`)
guarantees a cached pass can never be reported as a fresh one.

### S4 — Build failure
```bash
git checkout -b scenario/build main
# Must break the ENTRY graph, not just add a file. Vite bundles only what index.html
# reaches transitively, so an orphan frontend/src/scenario.ts with a bad import builds
# perfectly and the scenario passes for the wrong reason. Append to main.ts instead.
printf 'import { nope } from "./scenario-missing-module"\nexport const SCENARIO = nope\n' >> frontend/src/main.ts
git commit -aqm 'test: break the build' && git push -u origin HEAD
```
**Expected:** ✗ at **Build validation (vite build)** — the *last* frontend step, after lint,
types and tests all passed. Only the frontend ran; the backend job is skipped, which is the
correct amount of work.

That Vite detail is worth knowing when writing your own build-failure tests: the bundler is
not a linter, and "the build is green" means "the reachable graph compiles", not "every file
in `src/` is valid". Note also that `tsc --noEmit` covers all of `src/` via `tsconfig.json`
`include`, so an orphan with a broken import is caught by the *type check*, one step earlier.

### S5 — Frontend-only change: backend checks must NOT run
```bash
git checkout -b scenario/frontend-only main
# edit one file under frontend/src/
git commit -aqm 'feat: frontend-only change' && git push -u origin HEAD
```
**Expected:** `Detect changed components` summary shows Frontend = **yes**, Backend =
**no — skipped**. Grey skip icons on `Backend Quality` and `Docker verification · backend`.
`quality-gate / required` green, with backend rows reading **not applicable / skipped (no
relevant change)** — never "pass". Total wall clock under ~1.5 min.

### S6 — Backend-only change: frontend checks must NOT run
```bash
git checkout -b scenario/backend-only main
# edit one file under backend/internal/
git commit -aqm 'feat: backend-only change' && git push -u origin HEAD
```
**Expected:** the exact mirror of S5. `Frontend Quality` skipped, `Backend Quality` green.
`Security · Dependency vulnerabilities` still runs, but only its Go step — the npm step has
its own `if:`. `Security · Secret leak scan` always runs, because a secret in any component
is urgent regardless of what changed.

### S7 — Docker build failure
```bash
git checkout -b scenario/docker main
printf '\nFROM this-image-does-not-exist:no-such-tag\n' >> backend/Dockerfile
git commit -aqm 'test: break the image build' && git push -u origin HEAD
```
**Expected:** ✗ `Docker verification · backend` at **Build backend image (push disabled)**,
with BuildKit's layer-level error. `Frontend Quality` and `Backend Quality` **still pass** —
the Go code is fine; only the packaging is broken. That distinction is why container
verification is its own job rather than a step inside the build step, and it is the single
most useful piece of feedback in this table.

### S8 — Security failure
Two ways to demonstrate this, and the second is the better one.

**Option A — introduce a vulnerable dependency.**
```bash
git checkout -b scenario/security main
# Not `npm install --no-save cookie@0.6.0`: --no-save deliberately leaves package.json and
# package-lock.json untouched, so `git add frontend/package*.json` stages nothing and the
# commit is empty. The gate audits the COMMITTED lockfile, so an unsaved install is invisible
# to it -- the scenario would pass for the wrong reason.
(cd frontend && npm install --save-exact cookie@0.6.0 --no-audit --no-fund)
git add frontend/package.json frontend/package-lock.json
git commit -m 'test: add a vulnerable dependency' && git push -u origin HEAD
```

**Option B — change nothing but the policy.**
```bash
git checkout -b scenario/security-policy main
# Not `printf 'NPM_...=moderate\n' | tee .ci/security-policies.env`: tee TRUNCATES the file,
# so that one line becomes the whole policy and every other threshold silently disappears.
# The gate would then be running a policy nobody wrote -- a demonstration that the file is
# fragile, not that it works.
sed -i 's/^NPM_BLOCKING_SEVERITY_DEV=$/NPM_BLOCKING_SEVERITY_DEV=moderate/' .ci/security-policies.env
git add .ci/security-policies.env
git commit -m 'test: tighten the npm dev-dependency policy' && git push -u origin HEAD
```
**Expected:** ✗ `Security · Dependency vulnerabilities`. The job prints the **applied
thresholds first**, then the findings, then the blocking subset separately from the advisory
subset — so a reader can tell "the policy changed" from "a new advisory appeared". Option B
is the important demonstration: identical findings, unchanged code, different verdict,
because a threshold moved in a reviewable file.

✗ `Security · Secret leak scan` for a planted credential (see
[§6](#security--secret-leak-scan)), and ✗ `Security · Dependency review` when a PR *adds*
a HIGH runtime advisory.

---

## 11. Success criteria and measured baseline

**No arbitrary speed target was set.** A number invented before measurement ("CI must be
under 5 minutes!") becomes the thing people optimise instead of the thing they need. The
criterion is: *the gate is fast enough that developers wait for it rather than working
around it*, and the measurement below is what that claim is checked against.

Timings measured locally (WSL2, warm caches, `node_modules` present, Go build cache warm).
CI adds runner allocation, checkout and toolchain setup; treat these as a floor, and expect
the Docker jobs to dominate the real PR run.

| Validation | Measured | Notes |
| --- | --- | --- |
| `gofmt -l .` | 7 ms | |
| `go vet ./...` | 145 ms | |
| `go test -count=1 ./...` | 399 ms | |
| `go build` | 489 ms | |
| `eslint .` | 756 ms | |
| `tsc --noEmit` | 875 ms | |
| `vitest run` (40 tests) | 1,037 ms | `node` environment — no jsdom |
| `vitest run --coverage` | 830–1,660 ms | what CI actually runs, so the thresholds are enforced |
| `vite build` | 355 ms | |
| npm audit gate (both graphs) | 1.8 s | |
| govulncheck gate | 6.0 s | `go install` of a pinned version is most of it |
| actionlint (container) | 0.9 s | image already pulled |
| toolchain-sync / path-filters self-checks | 48 ms / 25 ms | |
| backend image build | ~18 s | local Docker |
| frontend image build | ~26 s | local Docker |

**Success criteria, as they will be evaluated on the next repository that adopts this:**

| Criterion | How it is measured | Status |
| --- | --- | --- |
| Relevant execution | Open a single-component PR; the other component's jobs show as skipped and the aggregate says "not applicable" | verified locally against the real filter file, 7 representative PR shapes; needs one real PR to confirm |
| Actionable feedback | Every failing step names one validation and prints its local reproduction command | implemented; `::error::` + `fix:` lines are the mechanism |
| No publishing from PR CI | `push: false` on every PR build; no write permissions at workflow scope; a job step asserts no registry credentials were present | implemented |
| Reliability / no flaky tests | Zero retries anywhere in the workflows. Deterministic by construction: `node` test environment, `-count=1`, no clock, no randomness, no network in unit tests, shuffled test order disabled | implemented; flakiness needs ~20 runs on real runners to confirm empirically |
| Blocked merge really blocks | Three tests in [docs/github-branch-protection.md](docs/github-branch-protection.md#verify-the-protection-actually-works), including an admin bypass attempt | **not yet run** — needs admin access on the real repo |
| CI speed | Compare against the table above after the first 10 real runs | **not yet measured on runners** |

The two "not yet" rows are the honest boundary of this POC: everything measurable without
a real GitHub repository has been measured, and the two items needing one are named rather
than glossed over.

---

## 12. Coverage matrix — what is and is not validated

| Validation | Frontend | Backend | Container images | Pipeline itself | Notes |
| --- | --- | --- | --- | --- | --- |
| Build | ✅ `vite build` | ✅ `go build` | ✅ both Dockerfiles | n/a | |
| Lint | ✅ ESLint 9 | ✅ `gofmt` + `go vet` | ⬜ | ✅ actionlint | |
| Type check | ✅ `tsc --noEmit` | ✅ via `go build` | n/a | n/a | Go is compiled; a separate step would be theatre |
| Unit tests | ✅ 40 tests, with coverage | ✅ `go test -count=1` | n/a | ✅ triage logic has its own tests | run with `--coverage` so the declared thresholds are actually evaluated |
| Coverage threshold | ✅ 70% lines/functions/branches/statements | ⬜ not enforced | n/a | n/a | measured at 98.3% / 90.9% / 93.3% / 98.3% |
| Container starts and serves | ✅ built and run | ✅ built and run | ✅ verified locally | | nginx + `scratch` both exercised end to end |
| Dependency vulnerabilities | ✅ prod graph blocks | ✅ reachability-based | ⬜ **not implemented** | ⬜ | |
| Newly-added dependencies | ✅ Dependency Review | ✅ | n/a | n/a | |
| Secrets | ✅ PR commits | ✅ | n/a | ✅ full history nightly | |
| Licence compliance | ⬜ | ⬜ | ⬜ | ⬜ | needs an allowed-licence list — a legal decision |
| SAST | ⬜ | ⬜ | ⬜ | ⬜ | no triage capacity yet; see §13 |
| Integration tests | ⬜ | ⬜ | ⬜ | ⬜ | no database in the POC |
| E2E / browser | ⬜ | ⬜ | ⬜ | ⬜ | see §13 |
| Accessibility, RTL, responsive | ⬜ | ⬜ | n/a | n/a | see §13 |
| Helm / K8s manifests | n/a | n/a | ⬜ | n/a | no charts exist |
| Signed commits | n/a | n/a | n/a | ⬜ | needs a key-infrastructure decision |
| Blocks merge on failure | ✅ | ✅ | ✅ | ✅ | **once the ruleset is applied** — see §8 |

Legend: ✅ implemented and verified · ⬜ deliberately not implemented (reason in §13) ·
n/a does not apply to this component.

---

## 13. Checks that depend on architecture — not implemented

These are **not** implemented because their correct shape depends on decisions this POC
cannot make. Each is listed with its reason and its path, so "absent" never reads as
"overlooked". Full table with implementation notes:
[docs/extending-the-gate.md](docs/extending-the-gate.md#checks-that-depend-on-architecture--deliberately-absent).

**DB migrations** · **Integration tests** · **E2E** · **Helm/K8s manifests** ·
**Generated-code drift** · **DB permission checks** · **Accessibility** ·
**Responsive/visual** · **Licence scanning** · **Mobile** · **Docs/link validation** ·
**Arabic/RTL** · **SAST (CodeQL)** · **Container image scanning** · **Signed commits** ·
**Rootless nginx**.

Two worth calling out because they are cheap and high-value:

- **Generated-code drift** — re-run the generator and `git diff --exit-code`. First thing
  to add the moment any code is generated.
- **Arabic/RTL linting** — logical CSS properties and no hardcoded `left`/`right` are
  lintable, so this belongs in the PR gate as soon as there is real CSS to lint. The POC
  has i18n strings but no layout, so there is nothing to check yet.

### Heavy checks belong elsewhere

> **A check that can be slow but must not be skipped belongs in the scheduled workflow.
> Speed is bought by moving work, not by dropping it.**

Full E2E suites, browser matrices, performance and load tests, and large-scale scans do not
belong in a PR gate. Not because they are unimportant, but because putting them there is
how you lose both the speed and the check: developers batch work into larger PRs, stop
rebasing, and eventually someone with admin rights merges past a red check "because it's
just the image scan". The budgets:

| Trigger | Budget | Belongs there |
| --- | --- | --- |
| PR | single-digit minutes | anything answering "may this merge?" |
| Scheduled | tens of minutes | downloaded databases, browsers, clusters, full history |
| On-demand | as long as it takes | long diagnostics a human wants now |
| Pre-release | as long as it takes | full E2E matrix, performance, migration rehearsal |

---

## 14. Assumptions and open decisions

Everything here is a **recommendation from a proof of concept**, listed so it can be
accepted or overridden deliberately rather than inherited by accident.

**Policy decisions the team owes:**

1. **npm production severity floor** — currently `critical,high`. Raise to `moderate`?
2. **npm dev-only findings** — currently reported, not blocking. This is the weakest point
   in the present policy: a supply-chain attack through a build dependency is not
   hypothetical.
3. **Reachable Go stdlib findings** — currently non-blocking, which keeps CI green while a
   reachable stdlib CVE exists. Acceptable? And who owns the toolchain bump?
4. **Dependency Review severity** — `high` here; GitHub's own default is `moderate`.
5. **Licence policy** — no allowed/denied list exists, so no licence check runs. Legal
   decision, not a CI decision.
6. **Notification path for scheduled failures** — branch protection cannot surface a
   nightly. A nightly nobody is told about is decoration.
7. **Container image scan threshold** — configured as `HIGH`, unread by any job.
8. **Coverage thresholds** — 70% lines/functions/branches/statements for the frontend, none
   for the backend. Both are policy statements, not technical necessity, and neither was
   derived from data. The frontend currently measures 98.3% lines / 90.9% functions /
   93.3% branches / 98.3% statements, so the gate is not the binding constraint today —
   which is exactly when a threshold is cheap to set and expensive to retrofit. CI runs the
   suite with `--coverage` so these numbers actually block; a threshold no command evaluates
   is decoration.
9. **Required approvals = 1** in the recommended ruleset. The POC measures the automated
   gate; extra human approvals measure people.

**Technical assumptions:**

10. **Go is pinned to 1.26.11, not the newest release** — it is the lowest line where
    govulncheck reports zero findings. That makes `.tool-versions` a *security* decision.
    1.25.x reports 9 reachable stdlib findings.
11. **The backend has zero third-party dependencies by design** (stdlib `net/http`), so
    supply-chain noise is nil and reviewers are not trained to ignore the dependency checks.
    The consequence is that `go.sum` handling, module-graph growth and Go dependency caching
    are all **untested**. Re-enable `cache: true` in `setup-go` in the same commit that adds
    the first real dependency.
12. **Scanners are called directly, not through third-party actions** (pinned containers for
    gitleaks and actionlint), to keep the supply chain small and the failure modes visible.
13. **Release authorisation is a plain file** (`.github/ci/release-branches.txt`) rather than
    a branch-protection API query — no extra token permission, it shows up in a PR diff, and
    it **fails closed**.
14. **Publishing is enabled by secret presence**, so the POC exercises the entire release path
    without a registry and needs no YAML edit to go live.
15. **Multi-arch builds and attestations are configured but unverified** — no registry is
    configured, so `provenance: mode=max` and `sbom: true` have never run end to end.
    Single-arch PR builds are fully verified, including provenance build-args in both images.
16. **Timings in §11 are local**, not from GitHub runners.

**Explicitly out of scope:** the reusable-workflow repository (`rihal-ci-workflows`). With one
consumer, the right abstraction is not visible; extracting now produces a shared workflow with
seven `if:` inputs nobody can change without breaking three teams. Extract after a second
repository adopts it. Rationale and target design in
[docs/extending-the-gate.md](docs/extending-the-gate.md#toward-a-company-standard-recommendation-not-policy).

---

## 15. Repository layout

```
.github/
  workflows/
    pr-quality-gate.yml     the merge gate — the deliverable
    release.yml             validate → build → publish (only path to a registry)
    scheduled-checks.yml    slow-but-necessary checks, nightly
  ci/
    paths-filter.yaml       change-aware execution: six filters
    toolchain.lock.env      Node + Go pins
    tools.lock.env          tool and analyser image pins, digest-pinned
    release-branches.txt    which branches are cleared for release (fails closed)
  pull_request_template.md  traceability lines + the "did you wire it into the aggregate" checkbox
.ci/
  security-policies.env     every security threshold. The only place to change one.
scripts/
  check-frontend.sh         all | lint | typecheck | test | build
  check-backend.sh          all | fmt | vet | test | build
  lib/ci-helpers.sh         gate_* output + policy helpers; authoritative GATE_ROOT
  lib/gate-bootstrap.sh     depth-independent way to find the helpers
  ci/                       self-checks: pins, path filters, actionlint, outdated deps
  security/                 scan wrappers, the secret-scanner canary test, triage modules
                            with their own tests, and a real captured govulncheck fixture
frontend/                   Vite + TS SPA. 40 Vitest tests. nginx template.
backend/                    Go stdlib-only HTTP service. No third-party dependencies.
docs/
  github-branch-protection.md   the configuration that makes red mean blocked
  security-baseline.md          what is checked, when, and what fails the build
  releasing.md                  triggers, traceability, authorisation, failure modes
  extending-the-gate.md         how to add a check; what is missing and why
docker-compose.yml          run the images CI builds, locally
.tool-versions              the single source of truth for Node and Go versions
.gitleaks.toml              extends the default ruleset; two project rules, allowlists specific
                            line shapes (never a directory)
```

### How the workflow and CI folders fit together

**`.github/workflows/` contains the GitHub Actions entry points.** On a PR to
`main`, `pr-quality-gate.yml` detects changed paths, runs the relevant component
and Docker jobs plus the security and pipeline checks, and reports one `required`
verdict. The PR workflow never pushes images. A GitHub ruleset must require that
verdict to actually block a merge. `release.yml` is separate: a push to `main`,
a version tag, or a manual run can validate and build multi-architecture images.
Publishing requires both an eligible commit and registry credentials. Images are
tagged by commit SHA, with a version tag when applicable; there is no automatic
deployment. `scheduled-checks.yml` runs nightly or manually to recheck dependencies
and scan Git history without delaying PRs.

**`.github/ci/` contains configuration, not workflows.**

| File | How it is used |
| --- | --- |
| `paths-filter.yaml` | The PR workflow maps changed files to frontend, backend, shared, Docker, and docs filters. For example, changing `frontend/src/main.ts` selects frontend validation and its Docker job, but not backend-only jobs. |
| `release-branches.txt` | The release workflow verifies that the commit is reachable from a listed branch. `DEFAULT` resolves to the repository’s default branch. |
| `toolchain.lock.env` | Records Node and Go versions plus Docker base image pins. The pipeline self-check compares these against `.tool-versions` and the Dockerfiles. |
| `tools.lock.env` | Pins analyzer versions for govulncheck, Gitleaks, and actionlint. |

Two similarly named paths serve different purposes: **`.ci/security-policies.env`**
contains scanner thresholds; **`scripts/ci/`** contains pipeline checks such as
pin synchronization, filter coverage, and workflow lint.

### The three conventions every script follows

1. **Check logic lives in a script, never inline in YAML.** A developer who cannot run the
   check that failed treats it as an opaque bot instead of a bug to fix.
2. **Every script sources `scripts/lib/gate-bootstrap.sh`.** Scripts that compute their own
   repository root each get to make their own off-by-one-directory mistake; one happened
   here and produced `gate_step: command not found` instead of anything useful.
3. **Non-obvious verdict logic is a tested module.** `scripts/security/*.mjs` is
   unit-tested, and `fixtures/` pins one real captured tool output, so a format change breaks
   a test rather than quietly disabling a check. A bug in triage logic produces a **false
   green**, which is strictly worse than a false red.

---

## Reading order for a reviewer

1. This file.
2. [`.github/workflows/pr-quality-gate.yml`](.github/workflows/pr-quality-gate.yml) — read
   the comment above the `quality-gate` job first; it explains the one thing most likely to be
   broken by a well-meaning refactor.
3. [docs/github-branch-protection.md](docs/github-branch-protection.md) — without this, the
   pipeline is a suggestion.
4. [docs/security-baseline.md](docs/security-baseline.md) — including §"Open questions".
5. [docs/releasing.md](docs/releasing.md) — why validation and publishing are separate.
6. [docs/extending-the-gate.md](docs/extending-the-gate.md) — read before adding anything.
