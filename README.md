# agent-base

Community-agnostic base framework for Claude Agent SDK bots, being extracted
from [`swampratnz/community-agent`](https://github.com/swampratnz/community-agent)
(the NZ Claude Community agent). The base owns the generic agent
infrastructure — platform adapters, three-tier RBAC, Postgres + pgvector
memory, CONFIRM-gated destructive actions, outbound secret redaction,
background jobs, budgets and alerting — and specific agents (a community
agent, a personal finance agent, …) plug in as **modules**.

## Status: contract, gates and docs — runtime pending

What exists today:

| | |
|---|---|
| `src/module-api/` | the **module API contract**: the typed manifest a module registers |
| `scripts/` | the **gates** — the security-test floor and the context-pack freshness check, generalised to multi-root layouts |
| `.github/workflows/` | CI running the full gate set, plus a **canary** that builds community-agent against this commit |
| `docs/MODULE-API.md` | what a module implements, written against community-agent's **real code** |
| `template/` | a starting point for a new agent repo |

The **runtime is not here yet, by design.** Per the extraction plan
([docs/ROADMAP.md](docs/ROADMAP.md)), the runtime is being disentangled inside
`community-agent` first — where ~200 test files, a security-test floor and a CI
pipeline adjudicate every step — and lands here by extraction, not by
greenfield rewrite. While that refactor is underway, `community-agent` is
authoritative wherever the two disagree, and this contract gets fixed to match.

## How a module plugs in

A module is a manifest of **registrations**. It never wires anything itself;
the base owns ordering and every enforcement point.

```ts
import type { AgentModule } from '@swampratnz/agent-base';

export const financeModule: AgentModule = {
  name: 'finance',

  // Env slice, parsed by the base loader and handed back typed at init.
  configSchema: z.object({ FINANCE_LEDGER_URL: z.string().url() }),

  // Tools: ONE declaration is the source for the tier surface, platform
  // filtering, feature flags, confirm gating and the capability rundown.
  tools: [
    {
      name: 'record_expense',
      description: 'Record an expense against the household ledger.',
      minTier: 'member',
      capabilityLine: 'record_expense — log a spend (member+)',
      schema: z.object({ amount: z.number().positive(), note: z.string().max(200) }),
      handler: async (args, ctx) =>
        ctx.audited('record_expense', args, async () => ledger.add(args)),
    },
  ],

  // Own tables, as idempotent SQL fragments run base-first in one transaction.
  migrations: [{ name: 'finance-core', sql: '…' }],

  // Own scheduled work; the base owns the scheduler, failure tracking and shutdown.
  jobs: [reconcileJob],

  // Own voice and prose, rendered BELOW the immutable security spine.
  promptSections: { charter: 'You are a household finance assistant…' },

  // Own share of privacy erasure — the base owns the transaction.
  purge: financePurgeContributor,
};
```

Then:

```ts
await createAgent({ modules: [financeModule] });
```

Two things that will not change:

- **Nothing a module registers can bypass an enforcement point.** Text packs
  return strings the base still filters; intercepts attach only after the
  security spine; a persona changes voice and never permissions; the skills
  allowlist can only ever be narrowed.
- **Registration is once, and reads fail closed.** A second registration
  throws rather than swapping a tool inventory or a notice pack after boot, and
  every accessor throws if nothing registered — never returning an empty list
  that would silently mean a narrower tool surface.

`createAgent` does not exist yet, and the snippet above is the contract's
intended shape rather than a working API.
[`docs/MODULE-API.md`](docs/MODULE-API.md) documents what genuinely exists
today, function by function, with every difference from these contract types
listed explicitly. Read that before building anything.

## Quickstart

```bash
git clone https://github.com/swampratnz/agent-base
cd agent-base
npm install

# the full gate — CI runs exactly this
npm run typecheck && npm run lint && npm run format:check \
  && npm test && npm run build \
  && npm run context:check && npm run test:security
```

Starting a new agent: copy [`template/`](template/) into a fresh repo and read
its README. It ships the conventions, the empty ratchet-state files and the
gate wiring — not a working app.

## Security posture (inherited, non-negotiable)

The base owns every enforcement point, and nothing a module registers can
bypass them:

- Built-in agent tools disabled per turn; skills allowlists explicit, never a
  wildcard; `WebFetch` disallowed for everyone.
- Roles come from env + the users table — never from message content. Tool
  surface is tier-derived from tool registrations; privileged handlers
  re-assert the tier.
- Destructive actions are CONFIRM-gated and executed by the router, not the
  model. The CONFIRM/CANCEL tokens are base-owned and untranslatable.
- Every outbound message passes the base outbound filter; module-supplied text
  packs return plain strings that still go through it.
- Admin data reads are conversation-scoped in SQL; the router's security spine
  is fixed and not reorderable by module intercepts.

The full write-up, including the development pipeline's own threat model, is in
[docs/SECURITY.md](docs/SECURITY.md).

## Layout

```
src/module-api/   the AgentModule manifest and its component types (v0)
tests/            contract tests and the gate scripts' own coverage
scripts/          the gates (security floor, context pack)
docs/             ROADMAP · MODULE-API · SECURITY · ARCHITECTURE · STANDARDS · RELEASING
docs/agents/      the committed context pack (gated by context:check)
template/         new-agent repo template
```
