<!--
Keep this short. It exists to make two things hard to forget, not to be a
checklist nobody reads.

Everything below the line is what a reviewer actually needs; delete what does not
apply, but do not delete the two traceability lines.
-->

## What changes, and why

<!-- One or two sentences. What is the problem, and why does this fix it? -->

## Which component(s)

- [ ] frontend
- [ ] backend
- [ ] CI / pipeline (`scripts/`, `.github/`, `.ci/`)
- [ ] docs only

## Traceability

Record the exact commit you pushed, so the CI run discussed in review and the commit
being merged are provably the same thing. This exists because force-pushing after a
review is approved replaces the tested commit with an untested one under the same
branch name.

- Commit pushed for this review: `<sha>`
- Latest commit at the time of writing: `<sha>` <!-- update on every push -->

If these differ, the green check you are reading validated a commit that is no longer
here.

## Local verification

Run the same commands CI runs, and say what you ran:

```bash
./scripts/check-frontend.sh   # lint, typecheck, test, build
./scripts/check-backend.sh    # fmt, vet, test, build
./scripts/security/scan-secrets.sh
```

- [ ] I ran the checks for the components I touched locally before opening this PR

The gate re-runs everything relevant regardless, so this is about how fast *you* get
the answer, not about correctness of the gate.

## Security

- [ ] This change adds no new dependency, **or** I have read the *Security · Dependency
      review* check and can explain anything it flagged
- [ ] This change adds no secret, token, or credential (including in a fixture or
      example)

If the secret scan flags something, treat it as compromised and rotate it *before*
removing the line. See `docs/security-baseline.md`.

## Pipeline changes only

If you touched `.github/`, `scripts/`, `.ci/`, or `.tool-versions`:

- [ ] `./scripts/ci/verify-toolchain-sync.sh` passes
- [ ] `./scripts/ci/verify-path-filters.sh` passes
- [ ] Any new check is wired into the `quality-gate` aggregate job's `needs:` **and**
      its `judge` list — a check that runs but is not aggregated does not block

That last one fails silently: the check appears to pass, the gate goes green, and
nothing was enforced.

## Notes for the reviewer

<!-- Anything you want a second pair of eyes on. Known trade-offs, alternatives
considered and rejected, follow-ups you are deliberately not doing here. -->
