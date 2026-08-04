# Architecture

The subsystems below are described by their *contract* — what they own, what
they must not do, and where the seam to a module is. All of them are here: the
runtime arrived by extraction from
[`swampratnz/community-agent`](https://github.com/swampratnz/community-agent)
(see [ROADMAP.md](ROADMAP.md)).

This page is the shape. For the base↔module boundary signature by signature,
read [MODULE-API.md](MODULE-API.md); for which file holds what, read
[agents/module-map.md](agents/module-map.md), which is gated against the tree
and therefore cannot drift.

---

## The shape

```
inbound message
   │
   ▼
platform adapter ─── normalises to IncomingMessage
   │
   ▼
router · pre-turn spine    13 frozen steps, block-list → … → auto-answer-thread
   │                        (PRE_TURN_SPINE; module intercepts append AFTER it)
   ▼
turn engine ─── system prompt (base spine + registered sections + persona voice)
   │            tool surface derived from the caller's tier
   ▼
tool kernel ─── one in-process MCP server per turn; audited / requireConfirm /
   │            callerScope / adapterFor / notify
   ▼
router · post-turn         registered handlers observe the finished turn
   │
   ▼
adapter send path ─── outbound filter (secret redaction + policy) ─── platform
```

Everything vertical is base. Everything a module contributes attaches
horizontally: tools into the kernel, sections into the prompt, intercepts after
the spine, handlers after the turn, jobs into the scheduler, fragments into the
migration, hooks into the storage lifecycles.

---

## Subsystems

### `agent/` — turn engine, prompt assembly, tool hosting

Builds the per-turn query options and runs the turn. Owns:

- the **tool surface** for the turn, derived from the caller's tier, the
  platform's declared capabilities, and live feature-flag predicates;
- the **system prompt assembler** — a fixed slot order with the security spine
  clauses at hard-coded positions and registered module sections below them.
  Output must be byte-identical per (role, policy, persona, day): prompt-cache
  hit rate depends on it, and a test pins it;
- the **tool-hosting kernel** — one in-process MCP server per turn, composed
  from the registered server name, context factory and inventory;
- the **CONFIRM flow** — pending actions the router executes, never the model;
- the **outbound filter** — deterministic secret redaction and content policy
  on every send path.

### `platforms/` — adapters and the platform registry

The `PlatformAdapter` contract plus the concrete adapters, split into two
layers by import weight: lightweight *descriptors* (platform id, member-id
rules) that leaf modules can dispatch over, and heavyweight *factories*
(constructors plus declared tool capabilities) that only the composition root
and adapter tests import. `Platform` is an open string; a tool's platform
restriction is derived from, and verified against, the adapters' declared
capabilities rather than hand-mirrored.

Also here: outbound text chunking, delivery-window handling, and the
adapter text packs that keep deployment prose out of adapter code.

### `storage/` — pool, embeddings, migrations, lifecycles

A single pool with explicit query/connection bounds, the embedding provider,
and a migrator that concatenates idempotent SQL fragments and applies them as
**one** multi-statement query — the all-or-nothing replay property is
load-bearing, so ordering is an explicit reviewable list, never a directory
glob.

Cross-cutting lifecycles (privacy purge, interaction invalidation, membership
removal, roster departure) are **registries with explicit ordering**, so each
domain owns its own rows and no module hard-codes another's tables. Iteration
order comes from a declared `order`, never from module load order.

### `src/` root — router, scheduler, notifications, health

There is no `runtime/` directory and there is not going to be one: these sit at
the `src/` root, next to `createAgent.ts`. The router spine (fixed, frozen,
non-reorderable — `router.ts` and `routerIntercepts.ts`), the job mechanism
(`jobs/`: tracked runs, re-entrancy latch, consecutive-failure alerting, cost
recording, one shutdown sweep), the notification service, the notice catalogue
with its locale/style precedence (`strings/`), retention sweeps, budget
accounting and crash handlers.

### `module-api/` — the v0 contract

Types only: no runtime, no enforcement. It describes the seams whose runtime is
not reified as registration yet. The manifest `createAgent` actually takes is
in `createAgent.ts`; where the two disagree, that one runs. See
[MODULE-API.md](MODULE-API.md) and [`../src/module-api/`](../src/module-api/).

---

## Composition

The entry point is

```ts
const agent = await createAgent({ modules: [myModule] });
await agent.start(() => startAdaptersAndJobs());
```

`createAgent` plans the composition purely, runs each module's `init`, performs
the singleton then additive registrations in a frozen order, and probes that
the registries took them — returning nothing at all if any required
registration is missing. `start()` runs the migrations (base fragments first,
then each module's, one atomic query) and then the caller's callback.

What it does **not** do yet, and the shape of the remaining work: config is
still an import-time singleton rather than a per-module slice parsed here, and
adapter construction, job starting and the shutdown sweep are still the
deployment's own callback rather than manifest fields. Each of those is a
seam marked `planned` or `partial` in [MODULE-API.md](MODULE-API.md).

---

## Deliberate non-goals

- **No plugin loading from disk or config.** Modules are code, imported by a
  composition root that a human wrote. An agent that can acquire behaviour at
  runtime is an agent whose tool surface is not reviewable.
- **No module-supplied filtering or rendering hooks on outbound sends.**
  Modules supply text; the base filters it. There is no extension point that
  runs *after* the filter, and there must not be.
- **No reordering of the security spine.** Not by configuration, not by
  registration, not by a well-argued special case.
