# Module map

One line per module, so a cold session can find the right file without
grepping the whole tree. Read [`README.md`](README.md) first.

**This file is gated.** `npm run context:check` (CI's lint job) fails if a
`src/` subsystem or top-level module has no entry, if an entry names a path
that no longer exists, or if entries are unsorted, duplicated, or left as
stubs. `npm run context:fix` does the mechanical part; it cannot write the
description, which is the part that matters.

Mark the security spine — the paths where a mistake is a security bug, not a
bug — with 🔒.

<!-- module-map:begin -->

- `src/main.ts` — Composition root: names this agent's modules and hands them to the base. Nothing else belongs here; wiring a runtime concern locally means a seam is missing.
- `src/migrate.ts` — `npm run migrate`: applies the base schema fragments and then this module's, in one query. Imports the runner by its own path, not the barrel, so it runs on DATABASE_URL alone.
- `src/module/` — This agent's module manifest and everything it registers: tools, tables, jobs, prompt sections, policy keys, string packs.

<!-- module-map:end -->
