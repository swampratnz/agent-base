# Module map

One line per module, so a cold session can find the right file without
grepping the whole tree. Read [`README.md`](README.md) first for how to use
this and [`recipes.md`](recipes.md) for the shape of a typical change.

**This file is gated.** `npm run context:check` (part of CI's lint job) fails
if a `src/` subsystem or top-level module has no entry, if an entry names a
path that no longer exists, or if entries are unsorted, duplicated, or left as
stubs. `npm run context:fix` adds/drops/sorts entries mechanically — it cannot
write the description, which is the part that matters.

Two things this map deliberately does **not** try to be:

- **A substitute for reading the code.** It tells you which file to open, not
  what the code says. Never assert behaviour from a one-liner here.
- **Complete.** Nested files inside a subsystem are called out only where the
  subsystem is big enough that "look in `src/agent/`" is not an answer.

The map is short right now because the tree is: this repo holds the module API
contract and the gates, and the runtime arrives by extraction from
`community-agent` (see [`../ROADMAP.md`](../ROADMAP.md)). The extraction pass
lands its entries in the same diffs that land the code — the gate makes that
non-optional.

The security spine — the paths where a mistake is a security bug, not a bug —
is marked **🔒**.

<!-- module-map:begin -->

- `src/index.ts` — The package's public surface: re-exports every module-API type. Nothing else is public API; if it is not exported here, a module must not import it.
- `src/module-api/` — 🔒 The `AgentModule` manifest and its component types — the whole base↔module contract. Registration shapes only: every enforcement point (tool gating, CONFIRM, outbound filtering, SQL scoping) is owned by the base runtime, and no type here may offer a way around one.

<!-- module-map:end -->
