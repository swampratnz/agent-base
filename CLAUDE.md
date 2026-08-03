# CLAUDE.md — conventions for this repo

Guidance for any Claude Code session working in `swampratnz/agent-base`.

## What this is

The community-agnostic base framework being extracted from
`swampratnz/community-agent`. Today it holds the **contract**, the **gates**,
the **docs** and the **new-agent template** — not the runtime, which arrives by
extraction rather than by being written fresh here.

Read `README.md`, then:

- `docs/ROADMAP.md` — what lands when, and the Phase 0 decisions of record.
- `docs/MODULE-API.md` — what a module actually implements, written against
  community-agent's **real code**, with a contract-vs-code table at the end.
  This is the most useful document in the repo; read it before believing a type.
- `docs/SECURITY.md` — the runtime invariants and the pipeline threat model.
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

- **Do not write runtime code here ahead of the extraction.** The runtime
  arrives by moving code that already has tests, a security floor and a
  pipeline adjudicating it. Writing it fresh here forfeits that. Contract
  types, gates, docs and template work are all in scope.
- **community-agent is authoritative on seam shapes** while its refactor is
  underway: if a seam lands there differing from these types, fix the types to
  match, and update `docs/MODULE-API.md`'s contract-vs-code table.
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
  && npm test && npm run build \
  && npm run context:check && npm run test:security
```

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

Both gate scripts take path flags (`--root`, `--src`, `--tests-dir`,
`--manifest`) so one copy serves this repo, a future workspace layout, and
every agent scaffolded from `template/`. Their own tests drive every failure
mode against fixture trees; extend those when you change a gate.

`scripts/check-dist-schema.mjs` is deliberately absent: it smoke-checks that
built SQL fragments match their manifest, and there is no storage layer here
yet. It comes with the storage extraction.

## Scope notes

- `.github/workflows/` is excluded from Prettier — automation here pushes with
  a token lacking the workflow scope, so it could never fix a failure there.
- `template/` is outside lint, Prettier and both tsconfigs: it is copied *out*
  of this repo, and its `main.ts` imports a runtime that does not exist yet.
  The gates will not catch a mistake in it; keep it honest by hand.
- The canary workflow (`canary-community-agent.yml`) cannot pass until
  community-agent depends on this package, so it is gated behind the
  `AGENT_BASE_CANARY_ENABLED` repository variable and skips by default. Turn it
  on in the same change that makes the consumer depend on the package.

## Conventions

- Match existing style; keep comments at the density of surrounding code —
  which here is high, and deliberately so: most of these files encode a
  decision whose *reason* is the load-bearing part.
- Imperative commit subjects; the body says why, not what.
- Human-facing conventions are in `docs/STANDARDS.md`; keep the two in sync.
