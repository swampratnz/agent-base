# Architecture

**Skeleton.** The subsystems below are described by their *contract* — what
they own, what they must not do, and where the seam to a module is. The code
lands by extraction from
[`swampratnz/community-agent`](https://github.com/swampratnz/community-agent)
(see [ROADMAP.md](ROADMAP.md)), and each section gets filled in by the diff
that brings its code across. Sections marked _(not here yet)_ describe the
intended arrival, not something you can import today.

For the base↔module boundary in detail, read [MODULE-API.md](MODULE-API.md) —
it is written against real code and is the more useful document until the
extraction lands.

---

## The shape

```
inbound message
   │
   ▼
platform adapter ─── normalises to IncomingMessage
   │
   ▼
router · pre-turn spine    block → role → gate → CONFIRM → pause → rate → budget
   │                        (frozen order; module intercepts append AFTER it)
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

### `agent/` — turn engine, prompt assembly, tool hosting _(not here yet)_

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

### `platforms/` — adapters and the platform registry _(not here yet)_

The `PlatformAdapter` contract plus the concrete adapters, split into two
layers by import weight: lightweight *descriptors* (platform id, member-id
rules) that leaf modules can dispatch over, and heavyweight *factories*
(constructors plus declared tool capabilities) that only the composition root
and adapter tests import. `Platform` is an open string; a tool's platform
restriction is derived from, and verified against, the adapters' declared
capabilities rather than hand-mirrored.

Also here: outbound text chunking, delivery-window handling, and the
adapter text packs that keep deployment prose out of adapter code.

### `storage/` — pool, embeddings, migrations, lifecycles _(not here yet)_

A single pool with explicit query/connection bounds, the embedding provider,
and a migrator that concatenates idempotent SQL fragments and applies them as
**one** multi-statement query — the all-or-nothing replay property is
load-bearing, so ordering is an explicit reviewable list, never a directory
glob.

Cross-cutting lifecycles (privacy purge, interaction invalidation, membership
removal, roster departure) are **registries with explicit ordering**, so each
domain owns its own rows and no module hard-codes another's tables. Iteration
order comes from a declared `order`, never from module load order.

### `runtime/` — router, scheduler, notifications, health _(not here yet)_

The router spine (fixed, frozen, non-reorderable), the job scheduler (tracked
runs, re-entrancy latch, consecutive-failure alerting, cost recording, one
shutdown sweep), the notification service, the notice catalogue with its
locale/style precedence, retention sweeps, budget accounting and crash
handlers.

### `module-api/` — the contract **(here now)**

The `AgentModule` manifest and its component types. Types only: no runtime, no
enforcement. See [MODULE-API.md](MODULE-API.md) and
[`../src/module-api/`](../src/module-api/).

---

## Composition

The intended entry point is

```ts
await createAgent({ modules: [myModule] });
```

which parses config (base slices plus each module's slice), runs migrations
(base fragments first, then modules in registration order, one atomic query),
constructs the adapters the deployment enables, wires the registered tools /
jobs / intercepts / handlers / commands, and installs one shutdown sweep.

**That function does not exist yet.** In community-agent today the composition
root performs side-effect imports of the module-owned registration files
before anything that could run a turn, and every registry fails closed if its
file was never imported. `createAgent` is the extraction pass's job; the
ordering constraints it must preserve are documented in
[MODULE-API.md](MODULE-API.md).

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
