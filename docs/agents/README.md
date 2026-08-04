# Agent context pack

**If you are an automated worker in this repo's pipeline, start here.**

Every pipeline worker is a fresh CI run, which means a **cold session**: no
memory of the run before it, no memory of the last twenty builds against this
repo. So every run re-derives the same orientation from scratch: what the
subsystems are, where a given behaviour lives, what a change here is normally
shaped like. That re-derivation is a real, repeated cost in turns and
wall-clock, and it produces nothing a human ever reads.

This directory is that orientation, **written down once and committed**:

| File | What it is for |
|---|---|
| [`module-map.md`](module-map.md) | Where things live. One line per `src/` subsystem and module. Gated by `npm run context:check`, so it cannot silently rot. |
| [`recipes.md`](recipes.md) | The shape of a typical change: which files a given kind of work touches, and which gate will fail if you miss one. |

## How to use it

1. **Read this pack before exploring the tree.** It is meant to *replace* a
   broad search sweep, not to precede one. If the map names the file you need,
   open that file directly.
2. **Then read the code you are changing.** The map tells you which file; it
   never tells you what the code does. Do not assert behaviour from a
   one-liner here — every claim in this pack is orientation, and the source is
   the only authority.
3. **If the pack is wrong, fix it in your PR.** A wrong map is worse than no
   map, because it is confidently wrong and the next cold session has no way to
   tell. Correcting it is always in scope, however small your change.

The governing documents are unchanged and this pack does not restate them:
[`../../CLAUDE.md`](../../CLAUDE.md) for conventions and the posture you must
not regress, [`../SECURITY.md`](../SECURITY.md) for the invariants,
[`../MODULE-API.md`](../MODULE-API.md) for the base↔module boundary as it
really is, and [`../ROADMAP.md`](../ROADMAP.md) for what lands when. When this
pack and one of those disagree, **they win and this pack has a bug**.

## A note on this repo specifically

**How something behaves is answered here.** The extraction has landed: the
runtime is in `src/`, the package is on npm, and `swampratnz/community-agent`
consumes it rather than carrying its own copy. So a base question is a question
about a file in this tree, and [`module-map.md`](module-map.md) names 70 of
them.

Two things still live in the consumer, and reading them here wastes a session:
the CONTENT (tools, prose, personas, notice text, jobs, adapters' factory list)
and the composition that assembles it. `docs/MODULE-API.md` marks which is
which and flags every consumer path as such.

The other direction matters too: a base change reaches community-agent as a
version bump, and the canary workflow builds that repo against this commit
nightly. If your change breaks the consumer, this repo finds out — which is why
a base fix belongs here and never downstream.

## Keeping it honest

The map is a manifest with a gate, in the same spirit as
`tests/security-floor.json`:

```
npm run context:check    # CI runs this in the lint job
npm run context:fix      # add/drop/sort entries mechanically
```

`context:fix` deliberately **cannot** make the gate green by itself: it inserts
a `TODO` stub for a newly added module and the check keeps failing until
someone writes the one-line description. That is the whole point — a fixer that
auto-satisfied the gate would let modules enter the tree undescribed, which is
exactly the rot the gate exists to prevent.

Scope is the source roots only (`--src`, repeatable; `src` by default). Gating
the test files would be a lot of upkeep for very little orientation.
