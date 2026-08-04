# Change recipes

The shape of the changes this repo actually gets, so a cold session does not
have to infer each one from the tree. Each recipe lists the files a change of
that kind normally touches and **which gate fails if you miss one** — the gate
is the part that turns a forgotten file into a red PR an hour later.

These are starting points, not permissions. Read
[`../ROADMAP.md`](../ROADMAP.md) for what is in scope at this phase.

---

## Every change, without exception

Run the full gate before opening or updating a PR — CI runs the identical set,
so a red PR only makes rework:

```
npm run typecheck && npm run lint && npm run format:check \
  && npm run migrate && npm test && npm run build \
  && npm run context:check && npm run test:security
```

`npm run migrate` is in that list because CI's build job runs it between
typecheck and test: the DB-backed tests skip when `DATABASE_URL` is unset, but
against a reachable database with no schema they fail on missing relations.
Point it at your OWN Postgres 16 + pgvector database, never a sibling repo's —
`node:test` runs test FILES in parallel and concurrent runs corrupt each
other's fixtures.

`npm run typecheck` also typechecks the **allowlisted** test files
(`tsconfig.tests.json`, an incremental ratchet). If it fails on a test file, fix
the test — do **not** remove its entry to go green. If you make another test
file type-clean, add it to the list; that is the intended unit of progress.

Then:

- **[`../SECURITY.md`](../SECURITY.md)** — if the change adds, removes or moves
  anything on the security spine, or introduces a new input, egress or trust
  boundary.
- **[`module-map.md`](module-map.md)** — if you added, removed or renamed a
  `src/` module. `npm run context:check` fails otherwise; `npm run context:fix`
  does the mechanical part.

---

## Changing runtime code (`src/**`)

The common change here, now that the runtime has landed. What it touches:

| File | Why |
|---|---|
| the module under `src/` | the change |
| its test under `tests/` | the assertion; a security-spine file needs a `SECURITY:`-prefixed one |
| `tests/security-floor.json` | if the `SECURITY:` count moved, **same diff** |
| `tsconfig.tests.json` | if you added a test file and it is type-clean |
| `docs/agents/module-map.md` | only if you added, removed or renamed a module |
| `docs/MODULE-API.md` | if the change touches a shape a module registers |
| `docs/SECURITY.md` | if it moves anything on the spine, or adds an input, egress or trust boundary |

Two properties are specific to being a framework, and both bite late:

- **A base change reaches the only consumer as a version bump.** There is no
  patching downstream. The nightly canary builds community-agent against this
  commit, so a break is visible here before a release — read its run rather
  than guessing.
- **Byte-stability is load-bearing** anywhere near prompt assembly: output must
  be identical per (role, policy, persona, day) or prompt-cache hit rates
  collapse and cost roughly doubles.

Gate that catches a miss: `npm run typecheck`, `npm test`, `npm run test:security`.

---

## Adding a registry, and wiring it into `createAgent`

The shape of "modules should be able to supply X". Four files, and missing the
third is the one that compiles and then fails closed at runtime:

| File | Why |
|---|---|
| the registry itself (e.g. `src/agent/<thing>.ts`) | `registerX` (throwing on a second call), a **non-throwing** `areXRegistered()` probe, and a fail-closed accessor |
| `src/createAgent.ts` | a field on `AgentModule`; a row in `SINGLETONS` if it is once-per-process; a row in `REQUIREMENTS` if base itself reads it on the turn path; the actual `registerX` call in step 3 or 4 |
| `tests/createAgent.test.ts` | that a composition missing it is REFUSED, and that two claimants collide |
| `docs/MODULE-API.md` | its own section, plus the manifest field table |

`REQUIREMENTS` is what makes a gap a startup error instead of a blank string in
front of a member, and it is kept **sorted by registry name** for the same
anti-merge-conflict reason as `security-floor.json`. Note the two-step check:
`planComposition` proves the manifests *say* they fill it,
`assertRegistrationsComplete` proves the registry took it. A registry that base
never reads belongs in `SINGLETONS` (or nowhere) but not in `REQUIREMENTS` — a
required registration nobody needs is a composition everybody has to satisfy.

Gate: `npm test`. Nothing else notices.

---

## Adding a schema fragment

| File | Why |
|---|---|
| `src/storage/schema/NN-name.sql` | the fragment. `IF NOT EXISTS` everywhere; it is REPLAYED over an already-applied production schema |
| `src/storage/schema/manifest.ts` | the explicit ordered array — never a glob, because order is load-bearing |
| `tests/schemaFragmentEquivalence.test.ts` | pins directory and manifest in sync |

`npm run build` copies the fragments into `dist/` and
`scripts/check-dist-schema.mjs` fails the build if they disagree — a package
that installs but cannot migrate is broken in a way no unit test sees. Run
`npm run migrate` against a real database and then run it AGAIN: replay is the
property that matters, and it is the one a fresh database never tests.

Numbering is preserved from community-agent (`00–27` core, `50–54` feature
tables, `70` adapter) so an existing deployment adopts these fragments without
a migration. Add at the end of the band.

Gate: `npm run build`, `npm run migrate`, `npm test`.

---

## Changing what a module registers (the manifest surface)

There is exactly ONE module contract: `AgentModule` in `src/createAgent.ts`,
re-exported from the barrel (also as `AgentModuleManifest`). There used to be a
second, in a `src/module-api/` of v0 sketches, and the barrel exported both —
issue #10, and the reason for the rule below.

| File | Why |
|---|---|
| `src/createAgent.ts` | the manifest field, plus its `SINGLETONS`/`REQUIREMENTS` row if the registry is required to serve a turn |
| the registry file | `register*()` and its fail-closed accessor — the field is a carrier, the registry is the mechanism |
| `src/index.ts` | the re-export, if a consumer needs to name the type |
| `tests/createAgent.test.ts` | the composition behaviour: plan-pass rejection, singleton collision, readiness probe |
| `tests/moduleApi.test.ts` | the BARREL's surface: a manifest written against the exported types must still satisfy `planComposition` |
| `docs/MODULE-API.md` | the section for that seam, and its **live** / **partial** / **planned** marking |

**The barrel exports live types only, from the files that run them.** An
extension point with no runtime gets a `planned` entry in `docs/MODULE-API.md`
saying where the behaviour lives today, and exports nothing — a document that
invents an API is bad, and an exported interface that invents one is worse,
because nobody builds against a paragraph.

Gate that catches a miss: `npm run typecheck` (both projects) and `npm test`.

---

## Adding or changing a `SECURITY:` test

| File | Why |
|---|---|
| the test file | the assertion |
| `tests/security-floor.json` | the per-file count, **in the same diff** |

Run `npm run test:security:fix` rather than hand-counting. It only ever raises
counts; removing a security test needs `--allow-lower` *and* an explanation in
the PR, and on a PR the CI baseline guard additionally refuses a lowering
unless the `allow-security-floor-lower` label is applied. That friction is the
feature.

Gate: `npm run test:security`.

---

## Touching a gate script (`scripts/**`)

| File | Why |
|---|---|
| `scripts/<gate>.mjs` | the change |
| `tests/contextPack.test.ts` / `tests/securityFloorGate.test.ts` | every failure mode is driven against fixture trees via `--root`; add a case for the new behaviour |
| `docs/agents/README.md`, `docs/STANDARDS.md` | if the invocation or the convention changed |

Two properties must survive any edit, because they are the whole point:

- the security floor is an **exact** match and its fixer can only raise counts;
- the context fixer **cannot** make its own gate green — it writes a stub that
  keeps the check red until a human writes the description.

A gate script change is a governance-path change: it needs a human merge.

---

## Adding a workflow, or editing CI

| File | Why |
|---|---|
| `.github/workflows/*.yml` | the change |
| `docs/SECURITY.md` §3 | if it changes who can push what, or what "green" means |

Keep `ci.yml` running the same gate set as the local one above; a check that
exists only in CI, or only locally, is a check that will drift. Pin actions by
SHA, keep `permissions: contents: read` unless a job genuinely needs more, and
keep `persist-credentials: false` — `npm test` runs PR code.

`.github/workflows/` is excluded from Prettier: the automation that maintains
this repo pushes with a token that lacks the workflow scope, so it can never
fix a formatting failure there.

---

## Anything under `template/`

`template/` is copied **out** of this repo to start a new agent. It is
deliberately outside the lint and Prettier scopes and outside both tsconfigs,
because formatting it here would impose this repo's choices on someone else's
future repo.

So the gates will **not** catch a mistake in there — and a broken scaffold is
invisible until somebody starts a repo with it. Verify by scaffolding:

```
cp -r template/. "$(mktemp -d)/my-agent" && cd "$_"
npm install     # resolves the PUBLISHED @swampratnz/agent-base
npm run typecheck && npm run lint && npm run format:check \
  && npm run migrate && npm test && npm run build \
  && npm run context:check && npm run test:security
```

Note what that install means: the template builds against the **published**
package, not this working tree. A template change that depends on an unreleased
export cannot be verified until the release, so either wait or say so in the
template.

Keep it a small, truthful starting point, never a fake working app: it passes
its own gate, and `npm run dev` refuses to compose until the required
registrations are filled in.

---

## Bringing code across from the consumer

The bulk extraction is **done** — `src/` is the lifted runtime and
community-agent has no `src/base/`. What remains is the occasional straggler:
something that turns out to be generic after all.

1. move the code and **its tests** together, verbatim where possible;
2. add each moved test file to `tsconfig.tests.json` if it is type-clean, and
   its `SECURITY:` counts to `tests/security-floor.json`;
3. add the new `src/` paths to [`module-map.md`](module-map.md) in the same
   diff — the gate will not let you defer it;
4. update the seam's section in [`../MODULE-API.md`](../MODULE-API.md) — and
   its `live` / `partial` / `planned` marking, if the move changed it.

**Diff the test file by NAME against the source commit, not by count.** The
security floor protects against deleting cases within a repo; it cannot see a
file arriving with fewer cases than it left with, because the receiving
manifest records whatever shows up as correct. `gatedNotice.test.ts` crossed
over having silently dropped 6 of its 7 cases and both manifests agreed with
each other the whole time. The other shape of the same hole is a module
arriving with no test file at all — `rbac.ts` and `outbound.ts` did, leaving 56
`SECURITY:` cases behind (issue #9, since covered by
`tests/rbac.test.ts`, `tests/rbacFailClosed.test.ts` and
`tests/outbound.test.ts`, written against the package boundary rather than
copied).

---

## Cutting a release

| File | Why |
|---|---|
| `package.json` + `package-lock.json` | `npm version <x.y.z> --no-git-tag-version` — it writes BOTH, and `npm ci` refuses a tree where they disagree |
| `CHANGELOG.md`, if the repo has one | what changed |

Then PR → merge → tag `v<x.y.z>` off the merged commit → push the tag. The tag
must equal `package.json`'s version exactly; the workflow refuses a mismatch.
Publishing is trusted-publishing (OIDC) and there is **no npm token anywhere
in this repository** — do not add one, and do not rename `publish.yml`, which
is what the publisher is registered against.

Full procedure, including the dry run that exercises everything short of the
OIDC exchange: [`../RELEASING.md`](../RELEASING.md). A release is a
governance-path change and needs a human.
