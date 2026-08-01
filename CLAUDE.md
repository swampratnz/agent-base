# CLAUDE.md — conventions for this repo

Guidance for any Claude Code session working in `swampratnz/agent-base`.

## What this is

The community-agnostic base framework being extracted from
`swampratnz/community-agent`. Currently a **contract-first seed**: only the
module API types exist here. Read `README.md`, then `docs/ROADMAP.md` for
what lands when, and `docs/SECURITY.md` for the invariants no contract change
may weaken.

## Ground rules

- **Do not add runtime code here during Phase 1** (see ROADMAP). The runtime
  arrives by extraction from community-agent, not by writing it fresh here.
  Contract-type changes are fine and expected.
- While Phase 1 is underway, community-agent is authoritative on seam shapes:
  if a seam lands there differing from these types, fix the types to match.
- Never weaken an invariant listed in `docs/SECURITY.md` via a contract
  change (e.g. making CONFIRM optional on a destructive path, letting a
  module supply executable filtering/rendering hooks on outbound sends, or
  deriving tiers from anything but storage/env).

## Build / verify

`npm run typecheck`, `npm test`, `npm run format:check`, `npm run build` —
all must be green before opening/updating a PR (CI runs exactly these).

## Conventions

- Same style rules as community-agent (`docs/STANDARDS.md` there): prettier,
  strict TS, node:test via tsx, comments at the density of surrounding code.
- Never commit secrets. Do not put model identifiers in commits or PRs.
