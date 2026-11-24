# Security baseline — what is checked, when, and what fails the build

This is the security half of the quality gate, spelled out so a reviewer can answer
"what did this green check actually verify?" without reading shell scripts.

Two rules govern everything below.

**1. Every threshold lives in `.ci/security-policies.env`, nowhere else.** A job
that hardcodes `--audit-level=high` cannot be audited, cannot be tuned, and cannot
be changed by the team without a YAML edit in three files. Change the number, the
workflows follow.

**2. A scan that did not run is never treated as a clean scan.** Every gate here
distinguishes "no findings" from "no output", and fails on the latter. This is not
paranoia: it is the normal failure mode of scanner wrappers, because a wrapper that
forwards the tool's exit code reports a crash as success.

---

## The checks

| Check | Scope | Blocks on | Where | Why here and not elsewhere |
| --- | --- | --- | --- | --- |
| **npm audit** | frontend lockfile | production graph: `critical,high` | PR + nightly | Fast (~1s), reads the lockfile without installing, catches what you just added. |
| **govulncheck** | backend module graph, call-graph aware | reachable third-party findings | PR + nightly | Symbol-level reachability means almost no false positives, so it can afford to block. |
| **Dependency Review** | only dependencies *this PR adds* | `high` and above, runtime scope | PR | Answers "is this change making us worse?" — the only question a reviewer can act on. |
| **gitleaks** | commits introduced by the PR | any finding | PR | A secret is compromised the moment it is pushed. Cannot be deferred. |
| **gitleaks (full history)** | every commit | any finding | nightly | Closes the gap for secrets committed before the gate existed. |
| **Image vulnerability scan** | built container images | `HIGH` (configured, **not implemented**) | — | Needs a downloaded vulnerability DB; too slow for a PR. See below. |

---

## npm audit (frontend)

**What runs:** `scripts/security/scan-frontend-deps.sh`, which runs `npm audit
--json` twice — once with `--omit=dev` (the production graph) and once with
everything — then hands both to `scripts/security/npm-audit-gate.mjs`.

**Why two audits and not one.** npm has no way to apply different severities to
production versus dev-only dependencies. Measured on this repository:

```
npm audit                    → 14 vulnerabilities (10 moderate, 1 high, 3 critical)  exit 1
npm audit --omit=dev         → 0 vulnerabilities                                      exit 0
```

So a single audit either blocks on dev-only tooling advisories that have no safe
upgrade (every frontend PR goes red, people learn to ignore the gate), or ignores
them and needs a second mechanism to be sure the shipped graph is clean. Comparing
both graphs makes the policy explicit and testable rather than implicit in a flag.

**The policy, and what is owed.** Blocking `critical,high` in the **production**
graph only is an *assumption of this POC*, not agreed policy. Recommendation:
confirm, then raise `NPM_BLOCKING_SEVERITY_DEV` from empty to `moderate`.

**Why the exit code is not trusted.** `npm audit` exits non-zero for *any* finding at
any severity. That is input to the triage, not a verdict.

---

## govulncheck (backend)

**What runs:** `scripts/security/scan-backend-deps.sh`, which runs
`govulncheck -format=json ./...` and passes the output to
`scripts/security/govulncheck-gate.mjs`.

Three properties of govulncheck, all measured rather than assumed, decide the design:

**1. `-format=json` always exits 0, even with findings.** Only text mode exits 3.
A workflow that runs the JSON format and trusts the exit code **reports a vulnerable
build as green** — the single most dangerous failure mode available here. The gate
therefore computes its verdict from the parsed findings and uses the scan's exit
status only to answer "did the tool run at all".

**2. Most findings are unreachable.** govulncheck reports both "this module is in
your graph" and "your code can actually reach this symbol". On this backend the
ratio was **243 findings, 9 reachable**. Findings whose trace contains no `function`
frame are unreachable and are reported, never blocking — a gate that blocks on all
of them is a gate that gets switched off.

**3. Severity is not available.** Every OSV record in the observed output had
`severity: NONE`, so a CVSS-style threshold would be theatre. Reachability is the
honest signal, which is why Go policy is expressed per *bucket* rather than per
severity:

| Bucket | Blocks | Fix owned by |
| --- | --- | --- |
| third-party, reachable | **yes** | the PR author |
| standard library, reachable | **no** (reports a warning) | whoever owns the toolchain bump |
| unreachable (graph only) | no | nobody yet |

**The stdlib carve-out is a decision, not a default.** A reachable standard-library
finding is fixed by bumping the pinned Go version — not by the author of the
unrelated feature PR in front of you. Blocking them stalls the queue and punishes
the wrong person. Set `GO_BLOCK_ON_STDLIB_FINDINGS=true` to change this; the team
still owes a decision on who owns "bump the toolchain" and how fast it must happen.

**Why govulncheck is installed per run.** It must be built with the same Go major
version as the toolchain on `PATH`, or it fails to load packages and reports
*nothing at all* — a silent false green. `go install` of a pinned version costs a
couple of seconds and always matches.

**A version note that matters.** Go 1.25.x reports 9 reachable stdlib findings;
1.26.11 reports none. The pinned version in `.tool-versions` is a security decision,
not a preference.

---

## Dependency Review (GitHub-native)

`actions/dependency-review-action`, configured `fail-on-severity: high`,
`fail-on-scopes: runtime`.

This is not redundant with the two above. npm audit and govulncheck judge the
repository **as it currently stands**, so a vulnerability already on `main` keeps
every subsequent PR red until someone fixes it — which is correct for the nightly
and useless for a reviewer. Dependency Review asks the narrower, actionable
question: *does this change introduce it?*

`moderate` is left to reporting deliberately: GitHub flags many, several with no
available fix, and a permanently-red gate is a gate people route around.

---

## Secret scanning

`scripts/security/scan-secrets.sh`, using gitleaks pinned by image digest.

**Why commits and not files.** A secret added in commit 3 of a five-commit PR and
deleted in commit 5 is invisible to a working-tree scan and permanently present in
the history everyone clones. So the scan takes a commit range.

**If it finds something, in this order:**

1. **Treat it as compromised now.** Rotate or revoke before anything else.
2. Removing the line is *not* remediation. The credential stays in history and
   anyone with clone access already has it.
3. History rewriting (`git filter-repo`) is a coordinated event: every clone and
   fork still has the object until it is garbage-collected server-side. Do it after
   rotating, never instead of rotating.
4. False positive (a pinned digest, a test fixture)? Add a **narrowly scoped** rule
   to `.gitleaks.toml`. Do not disable the check.

**The allowlist is a security decision.** This repository deliberately contains
hundreds of long hex strings — action SHAs and image digests pinned for supply-chain
integrity. `.gitleaks.toml` extends the default ruleset (`useDefault = true`) and
allowlists specific *line shapes*, never whole directories, because a
path-based exemption silently switches the check off for everything under it.

### What the default ruleset actually covers

Measured against gitleaks v8.30.1's shipped `config/gitleaks.toml` (222 rules) rather than
its documentation, because the difference turned out to matter.

The default ruleset is **strong on vendor token shapes** and **silent on generic credential
constructs** — close to the opposite of what a service repository actually leaks. A stray
`ghp_…` is caught from forty characters of noise; a database password in a compose file is
not a shape any of the 222 rules match.

Caught, verified: `ghp_`/`gho_`/`ghr_`/`ghs_`, `github_pat_` (length-exact, see below),
AWS key IDs, Slack, Stripe, npm, PyPI, GitLab, Twilio, SendGrid, Azure AD, GCP, JWTs,
private key blocks in every PEM flavour, plus `generic-api-key` for named-key assignments.

Not caught, and not fixable by configuration:

| Shape | Why | What closes it |
| --- | --- | --- |
| `postgres://user:pw@host` | No URI rule exists | **closed** by `credentials-in-connection-uri` |
| `Authorization: Basic <base64>` | No rule requires the header name | **closed** by `http-basic-auth-header` |
| `DB_PASSWORD="Password123!"` | `generic-api-key` has `entropy = 3.5`; weak passwords fall under it | **not closed** — see below |
| `mysql` Go DSN (`user:pw@tcp(host)/db`) | Not URI syntax | **not closed** — a Go-idiom-specific rule would be needed |

**Why the weak-password hole is left open deliberately.** `generic-api-key`'s entropy floor
of 3.5 is what keeps it usable, and lowering it via a project rule means matching
low-entropy strings that appear in ordinary code. The candidate rule was written and
measured: zero findings on this repository's tree, which makes it *viable* — but this POC
contains no prose, no fixtures and no example config, which is exactly where such a rule
fires. Recommending it as a company standard from this evidence base would be dishonest.
The recommendation is to trial it on a real repository, measure the false-positive rate for
two weeks, and then decide. A secret-scanner rule that blocks three unrelated PRs gets
deleted in its second week, and a deleted rule catches nothing.

Two rules **were** added, both narrow enough to be safe:

```toml
[[rules]]
id = "http-basic-auth-header"          # Authorization: Basic <base64>
[[rules]]
id = "credentials-in-connection-uri"   # a password inside a connection URI
```

Neither comment spells the literal shape it matches, and that is not fastidiousness: this
document is scanned like every other file, and writing the URI form out in full made the
security documentation the first thing the new rule flagged. `gitleaks.toml` carries the
same note. Anything that *describes* a credential format should avoid containing one.

`http-basic-auth-header` requires the header name rather than matching any `Basic
<base64>`, because the broader form also matches certificates, sourcemaps, inline assets
and base64 test fixtures. That leaves one known miss — `auth_header: Basic <base64>` in
YAML without the word `authorization` nearby — and the miss is preferred to the noise.

`credentials-in-connection-uri` carries a stopword allowlist for documentation
placeholders (`changeme`, `replace_me`, `yourpassword`, `example`, …). Without it the rule
flagged `postgres://user:changeme@localhost/db` in a README, which is the false positive
that trains people to reach for `--no-verify`. This is not exemption-by-location: a real
password on the *same page* as a placeholder is still reported, and both behaviours are
asserted by the canary test below.

Three details cost hours to discover and are worth recording, because each one looks
identical from the outside: "the scanner found nothing":

- **`github-fine-grained-pat` is `github_pat_\w{82}` — exactly 82.** A body 8 characters
  short never matches. Fine-grained PATs are the most likely real credential in a
  GitHub-hosted organisation, so this is the rule most worth getting right.
- **Sequential test payloads are allowlisted on purpose.** The default config's global
  stopwords list contains `abcdefghijklmnopqrstuvwxyz`. A test payload built from the
  alphabet is exempt by design, so the rule under test silently never fires.
- **`AKIAIOSFODNN7EXAMPLE` is not detected, and that is correct.** It is AWS's own
  documentation example and is covered by a global `.+EXAMPLE$` allowlist. So is a value
  ending in `EXAMPLE`. Test with a shaped-but-not-allowlisted key.

### Proving the scanner still works: `scripts/security/selftest-secrets.sh`

The scan's real failure mode is not a missed commit. It is a check that reports "no
secrets found" forever, and three things cause that silently:

1. an allowlist entry broadens and starts swallowing real credentials;
2. the ruleset or pinned image changes underneath the config;
3. the container is invoked in a way that produces an empty report.

`scan-secrets.sh` guards (3) — a scan of 0 commits is a failure, not a pass. Scanning the
repository cannot detect (1) or (2): *a scanner configured to see nothing passes every
scan of a repository that has nothing.*

So `selftest-secrets.sh` plants inert credentials in a throwaway git repository, scans it
with the same pinned container and the same `.gitleaks.toml`, and requires detection —
**asserting on the rule id that fired**, not merely "something fired". A catch-all
high-entropy rule matching everything would hide the fact that the GitHub-specific rule
stopped working.

The canary set deliberately mixes two kinds of rule. Vendor shapes (`github-pat`,
`private-key`, `aws-access-token`, …) prove the pinned default ruleset is intact. The
project's own rules (`poc-test-fake-secret`, `http-basic-auth-header`,
`credentials-in-connection-uri`) prove something the defaults cannot: that
`[extend] useDefault = true` is still present and that a hand-written regex has not been
edited into disuse. If someone replaces the config rather than extending it, every vendor
canary still passes while the project rules are dead — which only those three entries can
see.

The canaries live in a temp directory, deliberately not in this repository: a planted
secret in the real tree lives in history, and "rotate it, it's in the log now" applied to
a fake credential wastes an evening and teaches people that secret-scanner alerts are noise.

This creates a second-order problem worth stating, because it is easy to get wrong in a way
that defeats the whole design: the *source of the test* still lives in the repository, and
a literal credential in it would be flagged by the scanner under test. The only way to
silence that would be an allowlist entry for `scripts/security/` — a blanket, by-location
exemption, exactly what this script exists to detect. So payloads are stored as `|`-separated
fragments and re-joined at run time.

That is not cosmetic, and it is subtler than "don't write the secret". The first working
version split only the password inside the connection-URI canary, leaving `postgres://` and
`…@db.internal:5432/app` on the same line. That is still scheme + userinfo + host, so the
repository's own new URI rule flagged its own test file. The fragments have to break the
*matched construct*, not merely the credential — `postgres:` and `//ci_user` in separate
fragments, so no line in the file can match while the joined payload still does.

Verified together, because they are in tension: all canaries are detected, the committed
files themselves scan clean, and the tracked tree produces zero findings.

A partial miss is a warning; **detecting nothing at all is a hard failure**, because that
specifically means the check is off. Partial misses happen legitimately when gitleaks
renames a rule id between releases, and a Tuesday-afternoon PR should not be blocked by
one — but if the id changes, the CANARIES list should be updated *in the same PR*, which
makes the change visible instead of it becoming a widened allowlist.

Findings that came out of building it, each of which looks identical from the outside —
"the scanner found nothing":

- **gitleaks pretty-prints its JSON report** (`"RuleID": "x"`, with a space). A wrapper
  matching `"RuleID":"x"` finds nothing in real output and reports a permanently clean
  scan. This is why every scanner wrapper in `scripts/security/` **parses** rather than
  greps — and why this project's own test harness hit exactly that bug before the script
  did.
- **the report must be written to a host-mounted path** when running in a container.
  Writing it to a path inside the container loses it, and an absent report is
  indistinguishable from a clean scan unless the check is explicit.
- **`printf '%s\n' "$payload"` silently drops payloads beginning with `--`.** Bash's
  `printf` parses a leading `-` argument as an option, so the private-key canaries were
  never written to disk and the `private-key` rule appeared broken. The script uses a fixed
  format string, never one derived from the payload.
- **the canary's expected rule id must be read from the tool, not its docs.** `slack-token`
  does not exist; the rule is `slack-bot-token`. A guessed id produces a permanent warning
  that people learn to ignore, which is worse than not testing.
- **rule ids have length and charset constraints that fail silently.** `aws-access-token`
  requires `[A-Z0-9]{16}` after `AKIA`, so one lowercase character in a test key disables
  the rule entirely. `github-fine-grained-pat` is `\w{82}`, exactly. Both were written
  plausibly and matched nothing.

---

## Lockfile integrity — what `npm ci` does and does not guarantee

The gate installs with `npm ci`, commonly described as refusing to proceed unless the
lockfile is authoritative. Measured on npm 10.9.8 (Node 22.23.1), that is *mostly* true.
Every row below is one run of `npm ci` in a throwaway copy of `frontend/` with exactly one
field tampered with:

| Input shape | `npm ci` exit | Lockfile after |
| --- | --- | --- |
| `package.json` needs a version the lockfile lacks | **refuses** | unchanged |
| Extra dependency in `package.json`, absent from the lockfile | **refuses** | unchanged |
| Lockfile missing, or truncated to `{}` | **refuses** | unchanged |
| Corrupted `integrity` hash for one package | **refuses** | unchanged |
| Dependency removed from `package.json` only | accepts | unchanged |
| `lockfileVersion` set to 99 | accepts | unchanged |
| `lockfileVersion` downgraded to 1 | accepts | unchanged |
| `lockfileVersion` deleted | accepts | unchanged |
| Key order changed / trailing newline stripped / unknown top-level key added | accepts | unchanged |
| `resolved` URL repointed at another host | accepts | unchanged |

Two conclusions, and one of them corrects an earlier draft of this document.

**The `integrity` row is the load-bearing one.** It is what turns a compromised registry
mirror or a malicious tarball into a failed install rather than a green build. The refusal
rows mean `npm ci` genuinely cannot be made to resolve something nobody reviewed.

**`resolved` is authoritative, and that is a real attack surface.** Repointing all 308
`resolved` URLs at a local listener and clearing the cache made npm send **233 requests to
that host** and fail. The earlier conclusion that npm "ignores the field" was wrong, and the
confounder was npm's *global* cache: with warm tarballs on disk, the install succeeded
without ever contacting the host, which looks identical to "the URL was ignored" from the
outside. Two lessons: measure a network behaviour with an empty cache, and make the fake
host *answer* rather than fail DNS, because a connection log is proof where an error is
ambiguous.

The mitigation exists and works: npm's `replace-registry-host` config. Measured, empty
cache, every `resolved` URL repointed:

| Setting | Requests to the evil host | Install |
| --- | --- | --- |
| `npmjs` (**npm 10's default**) | **233** | fails |
| `never` | **233** | fails |
| `always` | **0** | **succeeds** |

The default is the worst of the three for this purpose: `npmjs` rewrites the host only when
it *already* says `registry.npmjs.org`, so a URL repointed to an attacker's host is left
exactly as written. `always` rewrites every `resolved` host to the configured registry, so
the lockfile cannot redirect the download at all.

Note what the unmitigated default does *not* imply: even then, a tampered lockfile can only
redirect *where bytes come from*, because the `integrity` hash must still match before
anything reaches `node_modules`. That hash is the layer doing the real work — but it is one
check, not a policy, and it is better not to depend on it alone.

> **A correction, recorded because the mistake is instructive.** This section previously
> claimed npm "accepts and *rewrites*" the lockfile for the `lockfileVersion` and
> `resolved` rows. It does not: the file is byte-identical after every one of those tampers.
> The probe had hashed the *pristine* original, tampered the copy, run `npm ci`, and
> compared — so it was reporting its own tamper as a rewrite. Measuring a mutation requires
> hashing the tampered input before running the thing under test. The wrong claim had
> already reached the README, a Dockerfile comment and a script; all three are corrected, and
> the verification harness now asserts the true behaviour so the error cannot come back.

### `replace-registry-host=always` — the one caveat that needs a human decision

`frontend/.npmrc` sets `replace-registry-host=always`. It is free here and it closes the
redirect, but it is not universally safe, and the reason is worth stating before anyone
copies this file into a real service:

**It breaks any package that must come from a host other than the configured registry.**
An organisation installing from GitHub Packages, a private Verdaccio, or a JFrog proxy has
`resolved` URLs pointing at *those* hosts on purpose. `always` rewrites them to the single
configured registry, and the install fails with a 404 for every private package. That is a
correct failure — it fails loudly, not silently — but it is a failure.

So the rule to carry forward is: **`always` for a repository that installs only from the
public npm registry; for a repository with private scoped packages, use a registry that
proxies both and point `registry=` at it, so there is genuinely one host to rewrite to.**
Deciding which category each Rihal repository falls into is a platform-team decision, not
something this POC can settle from one frontend.

The setting also has to be visible where `npm ci` runs, which is not obvious in a Docker
build: `frontend/Dockerfile` installs *before* `COPY . .`, so `.npmrc` is in the first
`COPY` list rather than riding along with the rest of the source.

### What the gate checks instead

An install that *rewrites* its own lockfile is still worth failing on — npm deciding the
dependency graph rather than reading the one under review is exactly the failure this gate
exists to catch — so `scripts/check-frontend.sh` still compares the SHA-256 before and
after. It is now labelled honestly: an invariant to protect against future npm versions,
not a bug measured in npm 10.9.8.

The real hole in the same function was elsewhere. `if [[ -d node_modules ]]; then return 0`
trusted *any* existing `node_modules`. In CI that directory never exists, so a CI-only
review can never see the consequence: switch branches on a laptop, run the gate, and lint,
type check, test and build a dependency tree left over from the branch you just left. The
gate's central claim is that CI and a laptop validate the same thing, so the install now
stamps `node_modules/.quality-gate-lockfile` with the lockfile's SHA-256 and re-installs
when it does not match. The check is one `cat`, so the fast path stays fast.

---

## Not in the PR gate, and why

| Check | Where it belongs | Reason |
| --- | --- | --- |
| Container image scanning | nightly | Scanner must download a vulnerability DB (hundreds of MB) before it can say anything. Would dominate PR runtime for commits that touch no Dockerfile. |
| SAST (CodeQL) | nightly + on-demand, **not implemented** | First run is minutes; findings need triage capacity before they can be made blocking. |
| Full-history secret scan | nightly | O(commits), and the result changes rarely. |
| DAST / penetration testing | pre-release environment | Needs a running stack. |
| Licence compliance | on-demand → then PR | A legal policy decision, not a CI decision. `license-check: false` in Dependency Review until an allowed-licence list exists. |

The pattern to add any of these is in [extending-the-gate.md](extending-the-gate.md).

---

## Container image scanning — configured but not implemented

`IMAGE_SCAN_SEVERITY_THRESHOLD=HIGH` and `IMAGE_SCAN_BLOCK_ON_THRESHOLD=true` exist
in the policy file, and **no check reads them yet**. That is intentional and stated
rather than hidden, because a stub that prints "skipped" and exits 0 shows up in the
Checks tab as a pass — worse than an acknowledged gap.

To implement: build the image in the scheduled workflow, scan the rootfs
(`trivy image --severity "$IMAGE_SCAN_SEVERITY_THRESHOLD" --exit-code 1`), and have
the aggregate scheduled job fail on the threshold. Scanning a *local* build rather
than a pushed tag avoids needing a registry just to test the scanner.

---

## Open questions the team still owns

Marked as **assumptions** throughout this repository, listed together so they can be
decided in one meeting rather than discovered one incident at a time.

1. **npm production severity floor.** Currently `critical,high`. Raise to `moderate`?
2. **npm dev-only findings.** Currently reported, not blocking. A supply-chain attack
   through a build dependency is not hypothetical; this is the weakest point in the
   current policy.
3. **Go stdlib findings.** Currently non-blocking, which makes CI green while a
   reachable stdlib CVE exists. Decide whether that is acceptable, and who owns the
   toolchain bump.
4. **Dependency Review at `moderate`?** GitHub's own default is `moderate`; this POC
   chose `high` for signal quality.
5. **Licence policy.** No allowed/denied list exists, so no licence check runs.
6. **Notification path for scheduled failures.** Branch protection cannot surface
   them. A nightly nobody is told about is decoration.
7. **Image scan threshold.** Currently `HIGH`; `CRITICAL` is defensible if false
   positives from base-image advisories prove unmanageable.
8. **Low-entropy password rule.** `DB_PASSWORD="Password123!"` is not detected by anything,
   because `generic-api-key` requires entropy ≥ 3.5. A rule that catches it was written and
   measured at zero false positives *on this repository* — which has no prose, fixtures or
   example config, the three places such a rule actually fires. Decide after trialling it on
   a real repository, not from this evidence base.
9. **Who owns the gitleaks version bump.** The image is pinned by digest, so rule-id changes
   arrive only when someone bumps it — and the canary test is what tells them. That makes
   the bump a security-relevant change needing a named owner, which currently nobody has.

---

## What this baseline does *not* claim

It does not claim the repository is secure. It claims that a specific, written set of
checks runs on a specific trigger, with a specific threshold, and fails the build
when exceeded. Those are different statements, and only the second one is something CI
can prove.
