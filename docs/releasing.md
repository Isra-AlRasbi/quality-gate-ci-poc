# Releasing

How a build becomes a published, traceable container image.

The controlling rule: **`pr-quality-gate.yml` validates and publishes nothing.
`release.yml` is the only path from source to a registry.** That separation is the
point of requirement 6, and the rest of this document is mechanics.

---

## Publishing is off right now, on purpose

`release.yml` probes three repository secrets at run time:

| Secret | Contents |
| --- | --- |
| `CI_REGISTRY` | Registry host only, e.g. `ghcr.io` or `registry.example.com`. No path. |
| `CI_REGISTRY_USERNAME` | A robot account, never a personal account. |
| `CI_REGISTRY_PASSWORD` | Token scoped to write only the packages this repository publishes. |

**All three present** → the image is pushed with SLSA provenance and an SBOM.
**Any missing** → identity checks, the full quality gate, and the complete
multi-architecture build all still run; only the push is skipped, and the job summary
says so plainly.

So the whole release path is exercisable today with no registry. Nothing is simulated
and nothing fails. Adding the secrets enables publishing with **no workflow edit** —
that is why the check is a runtime probe instead of a literal in the YAML.

Settings → Secrets and variables → Actions → **Repository secrets**.

### Why a missing secret must not be an error

If the workflow failed on an unset secret, this repository could never demonstrate its
own release path, and the temptation would be to comment out the publish step — at
which point re-enabling it becomes an unreviewed YAML edit. Probing keeps the code path
identical in both states; only one boolean differs, and it is derived from credentials
rather than typed by hand.

---

## Triggers

| Trigger | What happens |
| --- | --- |
| `git push` of tag `v1.2.3` | Full release: validate → build → publish, tagged with both the version and the commit SHA. A stable tag also moves `latest`. |
| `git push` of tag `v1.2.3-rc.1` | Same, but `latest` is **not** moved — a prerelease must not reach everyone consuming `latest`. |
| `git push` to `main` | Build and publish a **commit-SHA-only** image. No version tag: a branch has no version, and publishing `1.2.3` from a branch would let that name mean different things over time. |
| `workflow_dispatch` | You choose. `version` empty → commit-SHA build only. `include_latest` is opt-in. |

Tag format enforced by the workflow:

```text
v1            v1.2           v1.2.3         v1.2.3-rc.1         v1.2.3-rc.1+build.5
```

A bad tag fails with the expected pattern printed. Fix it by deleting the tag and
re-tagging — not by force-pushing over it:

```bash
git tag -d v1.2.3 && git push origin :refs/tags/v1.2.3
git tag -a v1.2.3 -m 'release 1.2.3' && git push origin v1.2.3
```

Use **annotated** tags (`-a`). A lightweight tag carries no author, date or message, so
the release record is thinner for no benefit.

---

## Which commits may be released, and why it is restricted

Anyone who can push a tag can trigger a release. Without a check, that means anyone who
can push `v9.9.9` could publish **any** commit — including one from a stale feature
branch that was never reviewed and never green. The tag would be the only audit trail,
and a tag is not a review.

So `release-identity` refuses any commit not reachable from a branch listed in
`.github/ci/release-branches.txt`:

```text
DEFAULT
```

`DEFAULT` expands to the repository's default branch. Add a release branch only if it
carries the same `quality-gate / required` check; a release branch that skips the gate
is not cleared for release, it is a bypass with a reassuring name.

The failure message is explicit:

> Commit `abc1234` is not reachable from any cleared release branch. Refusing to
> publish: this commit was never merged, never reviewed, and never passed the quality
> gate on a branch that carries the required check.

**Why a plain file instead of the branch-protection API:** it needs no extra token
permission, it appears in a PR diff when it changes, and it **fails closed**. An API
call that returns 403 would yield an empty allow-list, and "nothing is cleared" looks
identical to "everything is cleared" depending on how the code handles the error.

---

## The release flow

```
tag v1.2.3
  └─ release-identity           resolve version; verify commit is cleared; compute tag list
       └─ validate-release-commit   re-run the full gate over the exact released commit
            └─ publish-image         frontend + backend, linux/amd64 + linux/arm64
                 └─ release-summary  always runs; records commit, tags, digests
```

### Why the gate is re-run instead of reused

A tag is a pointer to a **commit**. The PR run validated a **merge commit** — a different
object with different content — and a tag can equally point at a commit from before a
rule existed. So the gate runs again over the exact thing being published.

`allow_unverified` skips it for a genuine emergency. It prints a warning annotation,
writes **EMERGENCY RELEASE** into the job summary, and leaves that trace permanently in
the run history. That visibility is the feature, not the escape hatch.

### Why build and publish share one job

Docker/BuildKit attaches provenance and SBOM attestations to the **registry manifest**, so
the builder must be the thing that pushes; splitting them would build the image twice.

The separation that actually buys safety is **credential scoping**: `publish-image` is the
only job with `packages: write` and the only one with `id-token: write`. A compromised
validation job cannot publish, cannot attest, and cannot reach a registry.

---

## Traceability — what a published image tells you

Every published image is tagged:

```text
rihal/quality-gate-backend:8f3a1c2e9d4b7a6f5e0c1d2b3a495867f8e0a1b2   ← always
rihal/quality-gate-backend:v1.2.3
rihal/quality-gate-backend:1.2.3
rihal/quality-gate-backend:sha-8f3a1c2
rihal/quality-gate-backend:latest                                     ← stable releases only
```

The full-SHA tag is unconditional. That is the guarantee: given a running container you
can name its commit even when nobody remembered to cut a version.

Beyond tags:

| Mechanism | Where it lives | How to read it |
| --- | --- | --- |
| Embedded `version` / `commitSHA` | the Go binary and the JS bundle, via `-ldflags` / `VITE_*` | `GET /api/version` |
| OCI source annotations | image config labels | `docker image inspect` |
| SLSA build provenance | registry attestation manifest | `docker buildx imagetools inspect --provenance <image>@<digest>` |
| SBOM | registry attestation manifest | `docker buildx imagetools inspect --sbom <image>@<digest>` |
| Workflow run | GitHub | linked in the release summary |

Verified locally in this POC:

```bash
docker build -f backend/Dockerfile --build-arg GIT_SHA=cafe…ef --build-arg APP_VERSION=1.2.3 -t qg-backend:prov backend
docker run --rm -p 18084:8080 qg-backend:prov &
curl -s localhost:18084/api/version
# {"commit":"cafebabe1234567890abcdef1234567890abcdef","service":"quality-gate-backend","version":"1.2.3"}
```

The frontend build likewise bakes both values into the bundle (`main.ts` reads
`import.meta.env.VITE_GIT_SHA`), so a deployed page can name its commit from
view-source.

**Not yet verified:** provenance and SBOM attestations need a real registry, so they are
configured but untested end to end. Everything else above was measured locally.

### Pin the digest, not the tag

The publish job prints:

```text
Published backend at digest sha256:...
Downstream consumers should pin: <image>@sha256:...
```

Tags are mutable names; a digest is content-addressed. `v1.2.3` is a *convention* that
someone with registry rights can repoint; a digest cannot be changed without changing
the bytes. Deployment manifests should reference the digest, with the tag kept in a
comment for humans.

---

## Multi-architecture, and its one real constraint

Images build for `linux/amd64` and `linux/arm64` via QEMU emulation.

**Constraint:** BuildKit can only attach attestations to a **registry push**. It also
cannot `load:` a multi-platform build into the local Docker daemon. So with no registry,
`release.yml` exports a multi-arch **OCI archive** instead and explicitly disables
attestations with a warning saying why.

The consequence for the PR gate, stated plainly: PR builds use `load: true` (so a later
step can assert the image exists) and therefore request **no** attestations. PR images are
throwaway; provenance belongs on artifacts that outlive the run.

QEMU emulation of a Go cross-compile is slow but reliable. If it ever becomes a problem,
the correct fix is `runs-on:` a native ARM runner rather than dropping arm64 — dropping an
architecture to save time is how you discover it the day someone deploys to an ARM cluster.

---

## Overwrite protection

Republishing `v1.2.3` with a different digest breaks every downstream pin of that name,
and after the fact is indistinguishable from an attack. So:

- **Tag push** — immutable by convention. Re-tagging is the correct fix for a bad release.
- **`workflow_dispatch`** — refuses unless `allow_overwrite` is explicitly set, which
  prints a warning and writes it into the job summary.

To roll back, redeploy the previous digest. Do not repoint `v1.2.3` at different content:
a version that silently means two things is worse than a version you have to increment.

---

## After a release

1. Read the **release summary** job — stage results, commit, trigger, run link.
2. Check the **Publish** job summary for the digest, and record it wherever deploys are
   tracked.
3. Confirm the tag in the registry shows provenance:
   ```bash
   docker buildx imagetools inspect --provenance <registry>/rihal/quality-gate-backend:<sha>
   ```
4. If publishing was skipped, the summary explains which secret is missing. That is not a
   failure — but do not let it become the permanent state, because an unpublishing release
   pipeline quietly stops being tested.

---

## Failure modes

| Symptom | Cause | Fix |
| --- | --- | --- |
| "not reachable from any cleared release branch" | Tag on an unmerged commit | Merge first, then tag the merged commit. |
| "`.github/ci/release-branches.txt` is missing" | File deleted | Restore it. The workflow refuses to guess which branches are safe. |
| "'x' is not a valid semantic version" | Tag name | Delete the tag, re-tag correctly. |
| Publish job skipped | A registry secret is missing | Expected state of this POC. Add the three secrets. |
| `push denied` | Token lacks `write:packages`, or the image namespace is not creatable by the robot account | Re-scope the token; create the namespace once manually. |
| Provenance missing from the registry | `id-token: write` was removed from `publish-image` | Restore it. Without it BuildKit **silently skips** the attestation — the build still looks successful. |
| `docker/build-push-action` fails with "multiple platforms feature is currently not supported" | `load: true` combined with `platforms:` | Expected. Use an OCI archive export (what the no-registry branch does). |
| arm64 build very slow | QEMU emulation | Add an ARM runner. Do not drop the architecture. |

---

## Where this would go for real

Publishing credentials should not be long-lived repository secrets. The natural next step
is OIDC federation to the registry, so each run mints a short-lived identity and there is
no secret to leak. The workflow already requests `id-token: write` for provenance, so the
same token can authenticate the push with no new permission — the change is registry-side
configuration, not a redesign. That is a platform decision, deliberately left out of a POC
whose job is to prove the gate shape, not to provision infrastructure.
