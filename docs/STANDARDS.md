# Contribution standards

A short, human-facing page. For the security invariants see
[SECURITY.md](SECURITY.md); for what a module may register see
[MODULE-API.md](MODULE-API.md); for where the extraction stands see
[ROADMAP.md](ROADMAP.md).

## Code style

Style is enforced by `eslint.config.js` and Prettier — run `npm run lint` and
`npm run format:check` before opening a PR; don't hand-debate in review what
the config already settles. Both configs mirror community-agent's, which is
where this code came from. Keep them in step: a straggler moving in either
direction should land under the rules it was written against, not go red on
style rather than substance.

## The full gate

```
npm run typecheck && npm run lint && npm run format:check \
  && npm run migrate && npm test && npm run build \
  && npm run context:check && npm run test:security \
  && npm run test:consumption
```

CI runs exactly this — `ci.yml` in three jobs, plus `consumption.yml`'s
`consume` job running the same `npm run test:consumption` across a toolchain
matrix. Run it before opening or updating a PR — a red PR only makes rework.

`test:consumption` is the one that asks whether a CONSUMER works: it packs the
real tarball, scaffolds `template/`, installs the tarball and runs the
scaffold's own gate and boot smokes. It needs `DATABASE_URL` too and skips
visibly without one — but a skip proves nothing, same as the DB-backed tests.

**Run the whole line, not `npm test` alone.** `npm test` does not check
`tests/security-floor.json`; `npm run test:security` is the only thing that
does, and CI runs it in its own job. A case in
`tests/securityFloorGate.test.ts` used to cover that gap by spawning the whole
`SECURITY:` suite from inside `npm test` — until it turned out to be running
`repository.test.ts`'s 117 DB-backed cases twice against one database, and
reddening unrelated PRs (issue #18). A convenience that fabricates a second
concurrent test runner is not worth its keep; running the documented gate is.

`migrate` needs `DATABASE_URL` on a Postgres 16 + pgvector database and nothing
else. Use your **own** database, never a sibling repo's: `node:test` runs test
FILES in parallel, so concurrent runs corrupt each other's fixtures. The same
rule is why nothing inside the suite may spawn a second runner over the same
database.

## Tests

- `node:test` via `tsx`, one file per subject under `tests/`.
- **Security invariants get a `SECURITY:`-prefixed test.** When you add or
  remove one, update that file's entry in `tests/security-floor.json` in the
  **same diff** — the gate is an exact match, not a floor. `npm run
  test:security:fix` regenerates the manifest; it only ever raises counts, and
  a genuine removal needs `--allow-lower` plus a PR explanation.
- `npm run typecheck` also typechecks the **allowlisted** test files
  (`tsconfig.tests.json`). It is an incremental ratchet: bringing another file
  to zero errors and adding it — alphabetically, one per line — is the unit of
  progress. **Never delete an entry to turn a red build green.**
- DB-touching tests must skip cleanly (not fail) when `DATABASE_URL` is unset,
  so a contributor without local Postgres is not blocked. The security-floor
  gate counts a skip the same as a pass, which is what keeps the required count
  stable across runners.

### Injected deps must be all-or-nothing

Where a unit takes an injectable `deps` object whose fields default to real
repository reads, that type must have **no optional fields**. A *partial*
object silently leaves the un-stubbed reads pointing at live Postgres, so a
"unit" test quietly queries the database — and because `node:test` runs test
**files** in parallel, those stray reads land on tables other files are
counting. That is a top source of cross-file flakiness, and it reddens
unrelated PRs.

So: pass **nothing at all** (production) to get the defaults, or pass **every**
field (tests). To stub only the reads a test cares about, spread a base whose
every field *throws*. Don't build a base of inert `async () => 0` stubs: a
newly added signal would silently acquire a plausible zero nobody chose, and
the test meant to cover it would pass vacuously.

## Finding your way around

`docs/agents/` is a committed context pack: `module-map.md` (one line per
`src/` subsystem and module) and `recipes.md` (what a given kind of change
touches, and which gate catches a missed file). It is aimed at the pipeline's
cold sessions, but it is the fastest orientation for a human too.

If you **add, remove or rename a module**, describe it in `module-map.md` in
the same diff — `npm run context:check` (CI's lint job) fails otherwise, and
`npm run context:fix` handles the mechanical part but deliberately cannot write
the description. The pack is orientation, not authority: read the code before
trusting a one-liner, and fix the line if it is wrong.

## Documentation that is part of the contract

Three files are load-bearing rather than descriptive, and a change that makes
one of them false is a broken change:

- **[MODULE-API.md](MODULE-API.md)** must stay true against real code. It
  documents what a module implements; a stale signature there is worse than no
  document, because someone will build against it — and since the package is
  published, "someone" is a repo you cannot fix.
- **[SECURITY.md](SECURITY.md)** must gain a note whenever a change adds,
  removes or moves anything on the security spine, or introduces a new input,
  egress or trust boundary.
- **`docs/agents/module-map.md`** is gated; see above.

## Commits and PRs

- No model identifiers in commit messages, PR titles/bodies, or code.
- Never commit secrets. Never copy another repo's env values into this one,
  even as an example — placeholder values only, and obviously placeholder.
- Imperative commit subjects, and a body that says *why* where the diff
  already says *what*.
- Every PR uses the template: Summary, Security / privacy impact, How
  verified. Keep those sections scoped to the diff — no secrets, tokens, env
  values, or hostnames in a PR body.
