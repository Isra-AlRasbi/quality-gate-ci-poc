# Branch protection: making a failed check actually block a merge

The workflows in `.github/workflows/` produce status checks. Status checks do not
block anything by themselves — without the configuration below, a red gate merges
anyway and the entire exercise is theatre.

This is the one part of the setup that cannot live in the repository. It is
configuration on GitHub, so it must be applied by someone with admin access and
verified independently. Treat "the POC is merged" as incomplete until the
verification steps at the bottom pass.

---

## Recommended: a Ruleset (not legacy branch protection)

Rulesets are the current mechanism, they apply to multiple branches at once, and
unlike legacy branch protection they can be exported as YAML — meaning the policy
itself becomes reviewable. Use legacy branch protection only if your plan does not
include Rulesets.

**Path:** Settings → Rules → Rulesets → **New ruleset**

### Target

| Setting | Value |
| --- | --- |
| Rule name | `protect-main` |
| Enforcement status | **Active** |
| Target branches → Include branches | `main` |

Add other protected branches (for example `release/*`) here as they appear. Note
that `.github/ci/release-branches.txt` must list the same branches — that file
tells the release workflow which commits may be published, this enforces the checks.
They are two different mechanisms that must agree, which is why
`scripts/ci/verify-toolchain-sync.sh` checks that the file exists and is non-empty.

### Rules to enable

| Rule | Value | Why |
| --- | --- | --- |
| **Restrict creations** | on | Stops a typo'd `git push origin new-main` creating a branch that looks protected. |
| **Restrict updates** | off | This limits updates to bypass actors. Use the PR and force-push rules instead so ordinary approved PRs can merge. |
| **Restrict force pushes** | on | Force-pushing over a green check replaces the tested commit with an untested one while keeping the same name. |
| **Restrict deletions** | on | Deleting and re-creating the branch is the oldest way around branch protection. |
| **Require a pull request before merging** | on, **1** approval | Every change gets a second pair of eyes. Not more: the POC's purpose is validating the automated gate, and extra human approvals measure people, not CI. |
| → Require review from code owners | off for the POC | Turn on when the repo has real owners; with one author it only lets them approve their own work. |
| → **Require approvals before review is dismissed** | off | Default. Dismissing on push is correct here because the gate re-runs on every push. |
| → **Restrict push access to PR authors** | on | Stops a collaborator pushing straight to the PR branch to sneak an unreviewed change past a review they did not cause. |
| **Require status checks to pass** | on — see the exact list below | The rule that does the actual gating. |
| → **Do not allow bypassing the above settings** | **on** | Without this, admins and the `GitHub Apps` listed as bypassers merge freely, and "required" means nothing. |
| **Require linear history** | off | Leave merge strategy to the team; merge commits are allowed in this POC. |
| **Require signed commits** | off for the POC | Real value, but it needs a signing key infrastructure decision that is out of scope here. See docs/extending-the-gate.md. |
| **Block merge commits** | off | A merge commit is how GitHub's own gate re-validates against the updated base. Blocking it trades a real safety property for tidier history. |

---

## The required status checks — get this exactly right

Under **Require status checks to pass**, add *only*:

```
quality-gate / required
```

That single check is produced by the `quality-gate` job with `name: "required"` in
`.github/workflows/pr-quality-gate.yml`. Search the dropdown for `required`.

### Why one check and not the seven job names

This is the subtle part, and getting it wrong creates a gate that passes when it
should fail.

A job whose `if:` condition evaluates to false is reported as **skipped**, and
GitHub treats a *skipped* check as **satisfying** branch protection. So consider
requiring `Frontend Quality` directly:

1. A developer opens a backend-only PR.
2. `detect-changes` reports `frontend=false`.
3. `frontend-quality` is skipped.
4. GitHub sees the required check as satisfied — **by a check that never ran**.
5. The backend check goes red, but the frontend requirement is green, so a
   collaborator with rights clicks merge.

The aggregate `quality-gate / required` job always runs (`if: always()`) and
computes the conjunction of only the checks that were *applicable*. Skipped
upstream jobs are therefore not a loophole — they are an input it reasons about.

### Two things that will bite you

**1. "Add checks" needs the check to have run at least once.** The dropdown is
populated from checks that exist in recent runs. On a brand-new repository, push
the branch, open a PR, let the workflow run once, then come back and add it. If you
configure protection first and the check name has never run, GitHub will let you
save a rule for a check that never arrives — and then **every PR is permanently
blocked** waiting for a check that will never report.

If you get stuck in that state: the rule can be removed, or the workflow
dispatched manually. The recovery is documented here because it is frightening the
first time it happens.

**2. `if: always()` on the aggregate job is load-bearing.** If someone refactors
the workflow and drops it, GitHub skips the aggregate job whenever any dependency
fails — turning a red gate into a *skipped* gate, which satisfies the requirement.
`scripts/ci/verify-path-filters.sh` greps for `if: always()` in the workflow and
fails the PR if it is missing, precisely so this cannot regress silently.

---

## Also configure (not branch protection, but part of the gate)

### Prevent CI from merging its own PRs

Settings → General → **Pull Requests → "Allow GitHub Actions to create and approve
pull requests"**: leave **unchecked**.

While unchecked, a PR opened by `github-actions[bot]` cannot be merged by a
workflow using the default token. Leaving it on means a compromised dependency in
the toolchain can open and merge its own PR using a token every workflow already
has.

### Pin the actions the workflow uses

Settings → Code security and analysis → **Actions → Approve or block actions**:
with the workflows already SHA-pinned, the highest-value setting here is
**"Allow all actions created by verified creators"**, which reduces to the org's own
reusable workflows later. SHA pinning in the YAML is the actual control; this is
defence in depth against someone editing a `uses:` line back to a tag.

Confirm the pins really are pinned:

```bash
grep -h 'uses:' .github/workflows/*.yml | grep -v '@[0-9a-f]\{40\}'
```

Expected output: nothing. Every `uses:` line is pinned to a 40-character commit SHA
with its version in a trailing comment.

### Configure notifications for the scheduled workflow

Settings → Notifications → **Checks**: enable for your account (org-level push
notification integration is better once this becomes a standard).

Branch protection cannot surface a scheduled workflow's failure — scheduled runs are
not attached to a PR. A nightly nobody is told about is decoration, so the
notification path is configuration you own, not something the YAML can arrange.

### Registry secrets (release publishing)

Not branch protection, but release.yml's publishing stays off until these exist.
Settings → Secrets and variables → Actions → Repository secrets:

| Secret | Example | Notes |
| --- | --- | --- |
| `CI_REGISTRY` | `ghcr.io` or `registry.example.com` | Host only, no path. |
| `CI_REGISTRY_USERNAME` | robot account | Not a personal account. |
| `CI_REGISTRY_PASSWORD` | PAT with `write:packages` | Scoped to the packages this repo publishes. |

release.yml probes all three at runtime and skips publishing when any is missing, so
adding them turns publishing on with no workflow edit.

---

## Verify the protection actually works

Do these three tests. A ruleset that "looks right" in the UI but does not block is
the failure mode that matters, and only an attempted merge proves it.

### Test 1 — a red gate blocks the merge

```bash
git checkout -b scenario/protect-lint
printf '\nexport const PROTECT_TEST: number = "not a number"\n' >> frontend/src/lib/status.ts
git commit -aqm 'test: break typecheck to verify branch protection' && git push -u origin HEAD
```

Open a PR. Expected: `quality-gate / required` reports ✗, and the merge button is
**disabled** with "This branch has checks that must pass". The merge is blocked even
with a valid approval.

### Test 2 — an approval alone is not enough

Approve the PR from a second account (or temporarily raise the required
approvals to 2 and approve with a spare account). Expected: still blocked, because
the check is red. This is what distinguishes a required check from an advisory one.

### Test 3 — an admin cannot bypass

With your admin account, on the same red PR, confirm there is **no** "Merge anyway"
option. If it appears, "Do not allow bypassing the above settings" is off, and
protection is advisory for exactly the people most likely to be in a hurry.

Then clean up:

```bash
git checkout main && git branch -D scenario/protect-lint
git push origin --delete scenario/protect-lint
```

---

## Exporting the ruleset

Once configured, **Settings → Rules → Rulesets → ⋯ → Export** gives YAML. Consider
committing it under `.github/rulesets/` so the policy is reviewable and so a future
standard can be applied to other Rihal repositories from source rather than by
clicking through the UI eleven times. That is a step toward the reusable-workflow
repository described in docs/extending-the-gate.md — the pipeline is only half of a
CI standard, and the protection rule is the half that decides whether it is a rule
or a suggestion.
