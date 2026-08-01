# Roadmap

The full extraction plan — including the complete base/community
classification of the source codebase, the coupling analysis, and the
per-phase risks — lives in
[`community-agent`'s docs/AGENT-BASE-PLAN.md](https://github.com/swampratnz/community-agent/blob/main/docs/AGENT-BASE-PLAN.md)
(community-agent PR #949). This file tracks where the work stands from this
repo's side.

## Strategy

**Strangle in place, extract last.** The runtime seams are reified inside
`community-agent` first, where its ~200 test files, security-test floor and
pipeline adjudicate every step. This repo starts as the _contract_ those
refactors code against, then receives the runtime by extraction — never by
greenfield rewrite.

## Phases

| Phase | What                                                                                                                                                        | Where           | Status               |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | -------------------- |
| 0     | Decisions: distribution (npm + reusable workflows), naming, module API v0                                                                                   | here            | **done** — this seed |
| 1     | Reify the seams: tool registry, config slices, storage fragments + hooks, job registry, strings catalogue, router intercepts, prompt slots, adapter factory | community-agent | not started          |
| 2     | Two packages in one repo (`src/base/` / `src/module/`), one-way import rule                                                                                 | community-agent | not started          |
| 3     | Extract: runtime packages, gate scripts, pipeline as reusable workflows, repo template                                                                      | here            | not started          |
| 4     | Prove the seams: scaffold the personal-finance agent from the template                                                                                      | new repo        | not started          |

## Contract stability

The module API here is **v0 and expected to move**. While Phase 1 is
underway, `community-agent` is authoritative: when a seam lands there with a
different shape than this contract guessed, the contract changes to match
(same-diff where practical). Consumers other than community-agent should not
build against this package before Phase 3 tags a 0.1.0.

## Phase 0 decisions of record

- **Distribution**: npm package(s) published to GitHub Packages, plus the
  pipeline as reusable workflows in this repo; per-repo state
  (security-floor manifest, tests-include ratchet, module map, VISION.md,
  theme labels, CI dummy env, governance-path list) stays per-repo.
- **Namespacing**: the MCP server key / `mcp__<ns>__` prefix is a module
  property (`AgentModule.name`), not a hardcoded literal.
- **DB naming**: physical table names (e.g. `community_users`) are kept for
  production compatibility; base docs/APIs use neutral names only.
- **`whats_new`/changelog**: base capability, opt-in per agent.
- **Platform set**: open string + adapter registration, never a closed union.
