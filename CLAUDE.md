# CLAUDE.md — conventions for this repo

Guidance for any Claude Code session working in `swampratnz/agent-base`.

## What this is

The community-agnostic base framework extracted from
`swampratnz/community-agent`. It holds the **runtime** (`src/` — the agent
kernel, platform adapters, storage + schema, router spine, jobs, auth, config),
the **contract** (`src/module-api/`), `createAgent`, the **gates**, the **docs**
and the **new-agent template**. The runtime arrived by extraction, not by being
written fresh here — see `docs/ROADMAP.md`.

Read `README.md`, then:

- `docs/ROADMAP.md` — what lands when, and the Phase 0 decisions of record.
- `docs/MODULE-API.md` — what a module actually implements, written against
  **this repo's real code**, with a contract-vs-code table at the end recording
  where the v0 types still differ. The most useful document in the repo; read
  it before believing a type.
- `docs/SECURITY.md` — the runtime invariants and the pipeline threat model.
- `docs/RELEASING.md` — how a release is cut, and why this package publishes
  to **public npmjs.com** rather than GitHub Packages.
- `docs/agents/` — the committed context pack for cold sessions.

## What is base and what is a module

**Base** owns mechanism and every enforcement point: tool gating and the
tier-derived surface, the CONFIRM flow, outbound filtering, SQL conversation
scoping, the router spine and its order, the prompt's security clauses and slot
order, the job scheduler, the migration runner, the purge transaction, the
notice-selection precedence, the skills allowlist rule.

**A module** owns content and policy: its tools, its tables, its jobs, its
charter and persona voice, its string packs, its policy keys, its ingest
sources, its share of the purge.

The test for which side something belongs on is not "is it generic?" but
"**could a module get this wrong in a way that matters?**". If yes, base owns
the mechanism and the module registers data into it.

## Ground rules

- **Prefer moving runtime code over writing it.** Anything that already
  exists in community-agent arrives by extraction, with its tests, its
  security floor and the pipeline that adjudicated it. Writing an equivalent
  fresh here forfeits all three. Bring the tests in the same diff as the code:
  issue #9 is what it costs when they are left behind — `rbac.ts` and
  `outbound.ts` shipped bare, and closing it meant writing 18 new cases against
  the package boundary because the originals could not be copied.
- **This repo is authoritative for base behaviour** now that the extraction has
  landed and community-agent consumes the package. A base change is made here
  and reaches the consumer as a version bump — never patched downstream. Where
  `src/module-api/`'s v0 types and `createAgent`'s live `AgentModule` disagree,
  the live one runs (issue #10); reconcile toward it and update
  `docs/MODULE-API.md`'s contract-vs-code table.
- **Never describe an unimplemented extension point as real.** Mark it
  `planned` and say where the behaviour lives today. A document that invents an
  API is worse than a missing one, because someone will build against it.
- **Never weaken an invariant in `docs/SECURITY.md` via a contract change** —
  e.g. making CONFIRM optional on a destructive path, letting a module supply
  executable filtering or rendering hooks on outbound sends, deriving tiers
  from anything but storage/env, or opening the prompt slot set.
- Never commit secrets. Never copy another repo's env values here even as an
  example — placeholders only, and obviously placeholder. No NZ-community
  content (charter, personas, te reo strings, skills, knowledge sources) lands
  in this repo: it is the module's, by definition.
- Do not put model identifiers in commits, PR bodies, or code.

## Build / verify

```
npm run typecheck && npm run lint && npm run format:check \
  && npm run migrate && npm test && npm run build \
  && npm run context:check && npm run test:security
```

`DATABASE_URL` must point at a Postgres 16 + pgvector database for the
DB-backed tests to actually run (`repository.test.ts` alone carries 117
`SECURITY:` cases). They SKIP cleanly when it is unset, so a contributor
without local Postgres is not blocked — but a skipped suite proves nothing, so
run them before claiming green. Use your OWN database, never a sibling repo's:
concurrent runs corrupt each other's fixtures because `node:test` runs test
FILES in parallel.

CI runs exactly this, in three jobs (`build`, `lint`, `security-invariants`).
All green before opening or updating a PR.

- `npm run typecheck` also runs `typecheck:tests` (`tsconfig.tests.json`), an
  **incremental ratchet**: `include` lists only test files that are type-clean.
  Adding a file is the unit of progress; never delete an entry to go green.
- `npm run test:security` enforces `tests/security-floor.json`, a per-file map
  of how many `SECURITY:` tests each file declares — an **exact** match, kept
  sorted. Update the entry in the same diff, or run
  `npm run test:security:fix`. That helper only ever RAISES a count; a genuine
  removal needs `--allow-lower` plus a PR explanation, and on a PR the CI
  baseline guard additionally refuses a lowering unless the
  `allow-security-floor-lower` label is applied.
- `npm run context:check` gates `docs/agents/module-map.md` against the tree.
  `npm run context:fix` does the mechanical part (add/drop/sort) but
  deliberately **cannot** make the gate green — it writes a `TODO` stub and the
  check keeps failing until someone writes the one-line description. A fixer
  that auto-satisfied this gate would let modules enter the tree undescribed,
  which is the exact rot it exists to prevent.

Both gate scripts take path flags so one copy serves this repo, a future
workspace layout, and every agent scaffolded from `template/`. The flag sets
are **not** the same, and passing the other script's flags is silently
ignored, not an error:

- `check-security-test-count.mjs` — `--root`, `--tests-dir` (repeatable),
  `--manifest`, `--write`, `--allow-lower`.
- `check-context-pack.mjs` — `--root`, `--src` (repeatable), `--map`,
  `--write`.

Their own tests drive every failure mode against fixture trees; extend those
when you change a gate.

`scripts/check-dist-schema.mjs` runs at the end of `npm run build`: `tsc`
compiles `storage/schema/manifest.ts` but never copies the `.sql` fragments, so
the copy step in the build script is what puts them in `dist/`. A forgotten or
partial copy would otherwise surface only as an ENOENT from `migrate:prod` on
the deploy box.

There is **no `imports:check` here**, deliberately. community-agent needs it to
enforce that its `src/base/` stays gone (a local copy forks the package
silently) and that only its composition root imports `createAgent`. This repo
IS the package: there is no module directory to import from, so the rule is
enforced by the repository boundary itself and porting the gate would add a
check that can never fail. If a `modules/` or `examples/` tree is ever added
here, port it then.

## Scope notes

- `.github/workflows/` is excluded from Prettier — automation here pushes with
  a token lacking the workflow scope, so it could never fix a failure there.
- `template/` is outside lint, Prettier and both tsconfigs: it is copied *out*
  of this repo, so formatting it here would impose this repo's choices on
  someone else's future repo. The gates therefore will not catch a mistake in
  it; keep it honest by hand, and verify a change by scaffolding a copy into a
  temp dir, `npm install`ing, and running its own gate there. Its imports
  resolve — `@swampratnz/agent-base` is a published dependency in its
  `package.json`.
- The canary workflow (`canary-community-agent.yml`) builds this commit,
  `npm pack`s it, installs the tarball into a community-agent checkout (no
  publish, no version bump) and runs that repo's typecheck/migrate/test/build.
  It is **on**: the `AGENT_BASE_CANARY_ENABLED` repository variable is set, the
  consumer declares the dependency and has deleted its `src/base/`, and the job
  runs daily on a `37 14 * * *` cron (plus `workflow_dispatch`, whose
  `force: true` bypasses the variable). So a red canary is a real signal about
  THIS commit, not expected noise — treat it as the consumer telling you a base
  change broke it before a publish does.
- The publish workflow (`publish.yml`) fires on a `v*.*.*` tag and runs the
  **same gate set as CI** before `npm publish`, because a tag can point at any
  commit — including one no PR ever adjudicated — and an npm version is
  immutable once published. Keep the two in step when you edit either.
  It publishes to public npmjs.com by **trusted publishing (OIDC)**: this
  repository holds **no npm token**, and none should ever be added. Three things
  follow, all of them easy to break by accident:
  **(a) do not rename the file** — the trusted publisher on npmjs.com is
  registered against the literal filename `publish.yml`, so a rename breaks
  every release until someone updates that setting;
  **(b) `id-token: write` at job level is the credential** — remove it and there
  is nothing to fall back on;
  **(c) provenance is automatic**, so `--provenance` is deliberately not passed,
  and it needs this repository to stay **public**.
  Trusted publishing also has hard floors (npm >= 11.5.1, Node >= 22.14.0) which
  the workflow upgrades toward and then asserts. `workflow_dispatch` defaults to
  a dry run that exercises everything and authenticates not at all. The
  bootstrap is **done**: `0.1.0` was the one-time manual publish npm's
  chicken-and-egg required, the trusted publisher was configured against it,
  and `0.1.1` shipped through the workflow. Every release from here is
  bump → PR → merge → tag, with no credential anywhere. Procedure:
  `docs/RELEASING.md`.

## Conventions

- Match existing style; keep comments at the density of surrounding code —
  which here is high, and deliberately so: most of these files encode a
  decision whose *reason* is the load-bearing part.
- Imperative commit subjects; the body says why, not what.
- Human-facing conventions are in `docs/STANDARDS.md`; keep the two in sync.
