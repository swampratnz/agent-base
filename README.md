# agent-base

Community-agnostic base framework for Claude Agent SDK bots, extracted from
[`swampratnz/community-agent`](https://github.com/swampratnz/community-agent)
(the NZ Claude Community agent). The base owns the generic agent
infrastructure — platform adapters (Discord/WhatsApp), three-tier RBAC,
Postgres + pgvector memory, CONFIRM-gated destructive actions, outbound
secret redaction, background jobs, budgets and alerting — and specific agents
(the NZ community agent, a personal finance agent, …) plug in as **modules**.

## Status: contract-first seed

What exists today is the **module API contract** (`src/module-api/`): the
typed manifest a module registers — tools with tier/confirm/audit
declarations, config schema slices, idempotent migration fragments, jobs,
prompt sections, string packs, intercepts, adapter factories, purge
contributors, and lifecycle hooks.

The **runtime is not here yet, by design.** Per the extraction plan
([docs/ROADMAP.md](docs/ROADMAP.md)), the runtime is being disentangled
inside `community-agent` first — where ~200 test files, a security-test floor
and a CI pipeline adjudicate every step — and lands here by extraction
(Phase 3), not by greenfield rewrite. While that refactor is underway,
`community-agent` is authoritative wherever the two disagree, and this
contract gets fixed to match.

## Security posture (inherited, non-negotiable)

The base owns every enforcement point, and nothing a module registers can
bypass them:

- Built-in Claude Code tools disabled per turn; skills allowlists are
  explicit, never `'all'`; `WebFetch` disallowed for everyone.
- Roles come from env + the users table — never from message content. Tool
  surface is tier-derived from tool registrations; privileged handlers
  re-assert the tier.
- Destructive actions are CONFIRM-gated and executed by the router, not the
  model. The CONFIRM/CANCEL protocol tokens are base-owned and untranslatable.
- Every outbound message passes the base outbound filter (secret redaction +
  policy); module-supplied text packs return plain strings that still go
  through it.
- Admin data reads are conversation-scoped in SQL; the router's security
  spine (block → role → gate → CONFIRM → pause → rate → budget) is fixed and
  not reorderable by module intercepts.

## Layout

```
src/module-api/   the AgentModule manifest and its component types (v0)
tests/            contract tests (node:test via tsx)
docs/ROADMAP.md   the extraction plan and current phase
docs/SECURITY.md  the base security spine contract
```

## Development

```bash
npm install
npm run typecheck && npm test && npm run build
```
