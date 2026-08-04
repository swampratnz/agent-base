# agent-base

Community-agnostic base framework for Claude Agent SDK bots, extracted from
[`swampratnz/community-agent`](https://github.com/swampratnz/community-agent)
(the NZ Claude Community agent). The base owns the generic agent
infrastructure — platform adapters, three-tier RBAC, Postgres + pgvector
memory, CONFIRM-gated destructive actions, outbound secret redaction,
background jobs, budgets and alerting — and specific agents (a community
agent, a personal finance agent, …) plug in as **modules**.

## Status: published, with one consumer

`@swampratnz/agent-base` is on public npm — `0.2.0` is `latest` — and
`community-agent` consumes it: it has no `src/base/` of its own any more.

`0.2.0` is a **breaking** release, which under `0.x` is a minor bump (see
[docs/ROADMAP.md](docs/ROADMAP.md)'s contract-stability note): the barrel now
re-exports live types only, so the v0 contract types it used to export
alongside them are gone. A consumer that imports its types by their deep paths
— as community-agent does — is unaffected.

| | |
|---|---|
| `src/` | the **runtime**: agent kernel and prompt spine, platform adapters, storage + 26 SQL fragments, the router spine, jobs, auth, config, notices |
| `src/createAgent.ts` | the **composition entry point**: `createAgent({ modules })`, and the registration order it owns |
| `tests/` | the suite that came across with the code, including the `SECURITY:` cases the floor gate counts |
| `scripts/` | the **gates** — the security-test floor and the context-pack freshness check, generalised to multi-root layouts |
| `.github/workflows/` | CI running the full gate set, the tag-triggered publish, and a **canary** that builds community-agent against this commit |
| `docs/MODULE-API.md` | what a module implements, written against **real code** |
| `docs/PIPELINE.md` | what automation this repo should grow, and why a release-confidence layer comes before agent loops |
| `template/` | a starting point for a new agent repo |

The runtime arrived by extraction rather than by greenfield rewrite (see
[docs/ROADMAP.md](docs/ROADMAP.md)), so it landed with its tests and its
security floor. This repository is now authoritative for base behaviour;
`community-agent` is authoritative only for what a *deployment* supplies.

## How a module plugs in

A module is a manifest of **registrations**. It never wires anything itself;
the base owns ordering and every enforcement point.

```ts
import { z } from 'zod';
import { createAgent, type AgentModuleManifest } from '@swampratnz/agent-base';

/** The per-turn context this module's own tool handlers receive. */
interface LedgerContext {
  userId: string;
}

export const financeModule: AgentModuleManifest<LedgerContext> = {
  name: 'finance',

  // The tool inventory plus the MCP server name it hangs under: the model
  // sees each tool as `mcp__finance__<name>`. `makeContext` builds the
  // per-turn context above; the base never looks inside it.
  toolServerParts: {
    name: 'finance',
    makeContext: (caller) => ({ userId: caller.userId }),
    registry: [
      {
        name: 'record_expense',
        description: 'Record an expense against the household ledger.',
        readOnlyHint: false,
        schema: { amount: z.number().positive(), note: z.string().max(200) },
        handler: async (args: { amount: number; note: string }, ctx) => ({
          content: [{ type: 'text', text: `Recorded ${args.amount} for ${ctx.userId}: ${args.note}` }],
        }),
      },
    ],
  },

  // The per-tier tool surface, computed before the model sees anything.
  toolTiers: { member: ['record_expense'], admin: [], superAdmin: [], discordOnly: [] },

  // Own tables, as idempotent SQL fragments applied after every base fragment
  // in the same one-shot migration.
  migrations: [{ name: 'finance-core', sql: 'CREATE TABLE IF NOT EXISTS finance_expenses (…)' }],

  // Own runtime policy keys, with the value a never-set key reads as.
  policyKeys: { finance_month_start: 1 },
};

const agent = await createAgent({ modules: [financeModule] });
await agent.start(); // pass a callback to bring adapters and jobs up
```

That manifest is an excerpt. A composition must, across all its modules,
supply the **nine required registrations** — notice pack, tool tiers,
tool-server parts, flagged-tool predicates, skills manifest, prompt sections,
commands, default bad words, and a default persona — or `createAgent` reports
every gap at once and returns nothing. `promptSections` in particular is a
closed, all-required slot set of nine fields;
[`docs/MODULE-API.md`](docs/MODULE-API.md) lists them.

Two things that will not change:

- **Nothing a module registers can bypass an enforcement point.** Text packs
  return strings the base still filters; intercepts attach only after the
  security spine; a persona changes voice and never permissions; the skills
  allowlist can only ever be narrowed.
- **Registration is once, and reads fail closed.** A second registration
  throws rather than swapping a tool inventory or a notice pack after boot, and
  every accessor throws if nothing registered — never returning an empty list
  that would silently mean a narrower tool surface.

[`docs/MODULE-API.md`](docs/MODULE-API.md) documents every extension point
function by function, marking each **live**, **partial** or **planned**. Every
type the barrel exports is a live one, from the file that runs it — a planned
extension point is described there and exports nothing, because a type is a
stronger claim than a paragraph and somebody will build against it.

## Quickstart

```bash
git clone https://github.com/swampratnz/agent-base
cd agent-base
npm install

# the full gate — CI runs exactly this
npm run typecheck && npm run lint && npm run format:check \
  && npm run migrate && npm test && npm run build \
  && npm run context:check && npm run test:security
```

`npm run migrate` needs `DATABASE_URL` pointed at a Postgres 16 + pgvector
database (and nothing else — the boot config slice validates db + log only).
The DB-backed tests skip cleanly without it, so a contributor with no local
Postgres is not blocked — but a skipped suite proves nothing.

Consuming it from an agent is `npm install @swampratnz/agent-base` — public
npm, no token, no `.npmrc`. The barrel is a small convenience surface and
every compiled module is addressable by its source path
(`@swampratnz/agent-base/router.js`); see
[docs/RELEASING.md § The consumer side](docs/RELEASING.md#the-consumer-side).

### Want the WhatsApp **Baileys** provider?

Install it alongside — it is an **optional peer**, not a dependency:

```bash
npm install @swampratnz/agent-base @whiskeysockets/baileys
```

Everything else works without it. Only
`@swampratnz/agent-base/platforms/whatsapp/baileysAdapter.js` imports Baileys
at runtime, so a Discord-only agent, or one using the WhatsApp **Cloud**
provider, never needs the package. Import that module without it and you get a
plain `ERR_MODULE_NOT_FOUND`.

**Why it is not a dependency.** Baileys declares `libsignal` over `git+https`,
and **npm 12 refuses every git-protocol fetch** (`EALLOWGIT`). While Baileys sat
in `dependencies`, nobody on npm 12 could install this framework *at all* —
whether or not they wanted WhatsApp — because npm resolves the whole tree before
anything runs. As an optional peer the constraint follows the feature: install
the framework on any npm, and **if you want Baileys, use npm 11.x**
(`npm i -g npm@^11.5.1`) until Baileys stops depending on git. See issue #29.

Node is unaffected either way: `engines` is `>=22`, and 22 and 24 are both
exercised in CI.

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
src/createAgent.ts  the composition entry point and its frozen registration order
src/agent/          turn engine, prompt spine, tool kernel, CONFIRM flow, outbound filter
src/platforms/      the adapter contract and the Discord / WhatsApp adapters
src/storage/        pool, embeddings, schema fragments + migrator, lifecycle registries
src/router.ts       the hot path; src/routerIntercepts.ts holds the frozen pre-turn spine
src/auth/           tiers and role resolution; src/strings/ the notice catalogue
src/index.ts        the public barrel — live types only, from the files that run them
tests/              the lifted suite, including every SECURITY: case the floor counts
scripts/            the gates (security floor, context pack, dist schema)
docs/               ROADMAP · MODULE-API · SECURITY · ARCHITECTURE · STANDARDS · RELEASING
docs/agents/        the committed context pack (gated by context:check)
template/           new-agent repo template
```

`docs/agents/module-map.md` is the file-by-file version of this, and it is
gated — one line per subsystem, kept honest by `npm run context:check`.
