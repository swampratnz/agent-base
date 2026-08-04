# CLAUDE.md — conventions for this repo

TODO: replace `my-agent` throughout, then delete this line.

Guidance for any Claude Code session working in **my-agent**.

## What this is

An agent built on [`@swampratnz/agent-base`](https://github.com/swampratnz/agent-base).
The base owns the runtime and every enforcement point; this repo is a
**module** — the tools, tables, jobs, prose and policy that make it this agent.

Start with `README.md`, then `docs/VISION.md` (what is worth building here) and
`docs/SECURITY.md` (what this deployment protects). For the base↔module
boundary, read the base repo's `docs/MODULE-API.md` — it says which extension
points are real today and which are still planned.

## Base vs. module

**Do not reimplement a base mechanism locally.** Tool gating, the CONFIRM
flow, outbound filtering, SQL conversation scoping, the router's pre-turn
security spine, the prompt's security clauses, the migration runner, the purge
transaction, the notice-selection precedence, the skills allowlist rule — all
base. If one of them does not fit, that is a base issue to raise, not a local
workaround to write. A local copy of an enforcement point is a second place for
it to be wrong.

Everything under `src/module/` is yours.

## Security posture (do not regress)

This bot may process untrusted public chat. Preserve these, all inherited:

- Built-in agent tools are disabled per turn; the skills allowlist is explicit
  and never a wildcard; `WebFetch` is disallowed for every tier.
- Roles come from env + the users table — **never** from message content. Tool
  surface is tier-derived; privileged tools re-assert the tier.
- Destructive actions are CONFIRM-gated and executed by the router, not the
  model.
- Outbound filtering (secret redaction + policy) is on every send path. The
  exact-value secret list it redacts is the BASE's `runtimeSecrets()`, which a
  module cannot add to today — so an outward credential of your own must be
  redacted at your own send site, and named as a residual risk in
  `docs/SECURITY.md` until the per-credential registration seam lands.
- Admin data access is scoped in SQL to conversations the admin is in.

Anything you add that touches one of these needs a `SECURITY:`-prefixed test.

## Build / verify

```
npm run typecheck && npm run lint && npm run format:check \
  && npm run migrate && npm test && npm run build \
  && npm run context:check && npm run test:security
```

All green before opening or updating a PR; CI runs the same set. `migrate`
needs `DATABASE_URL` pointed at Postgres 16 + pgvector and nothing else.

Three ratchets, each of which will fail a PR that forgets its companion file:

- **`tests/security-floor.json`** — a per-file, **exact** count of
  `SECURITY:` tests. Update it in the same diff as the test, or run
  `npm run test:security:fix`. It only ever raises counts; a genuine removal
  needs `--allow-lower` and an explanation.
- **`tsconfig.tests.json`** — the tests typecheck ratchet. Add a file once it
  is type-clean; never delete an entry to go green.
- **`docs/agents/module-map.md`** — gated by `npm run context:check`. Describe
  a module in the diff that adds it. `npm run context:fix` inserts a stub and
  deliberately leaves the gate red until someone writes the description.

DB-touching tests must **skip** cleanly when `DATABASE_URL` is unset, not fail.

## Conventions

- Match existing style; keep comments at the density of surrounding code.
- Never commit secrets. `.env` is git-ignored; keep platform auth state out of
  the tree.
- No model identifiers in commits, PR bodies, or code.
- TODO: your changelog convention, including which timezone its dates use — a
  bare `date` in a UTC CI shell is a day off for much of the world.
