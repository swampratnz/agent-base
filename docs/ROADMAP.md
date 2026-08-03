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
| 1     | Reify the seams: tool registry, config slices, storage fragments + hooks, job registry, strings catalogue, router intercepts, prompt slots, adapter factory | community-agent | **largely landed**   |
| 2     | Two packages in one repo (`src/base/` / `src/module/`), one-way import rule                                                                                 | community-agent | not started          |
| 3     | Extract: runtime packages, gate scripts, pipeline as reusable workflows, repo template                                                                      | here            | **in progress**      |
| 4     | Prove the seams: scaffold the personal-finance agent from the template                                                                                      | new repo        | not started          |

### Where Phase 1 actually stands

Read from community-agent's `src/` rather than from anyone's status report.
`docs/MODULE-API.md` has the signatures and the full breakdown; in summary:

- **Live registries**: tool registry (`defineTool` + derived tier arrays,
  tool-server parts and feature-flag predicates), storage lifecycle hooks
  (purge contributors, interactions-invalidated, member-removed, roster-leave),
  provenance→trust, policy keys, the notice catalogue with open locale axes,
  prompt sections (a **closed** slot set), personas, the skills manifest, the
  command registry, the router's pre-turn intercept and post-turn handler
  registries, turn-state finalizers, and the job registry.
- **Partial**: config (per-domain slices exist and a boot slice already lets
  `migrate` run on `DATABASE_URL` alone, but `config` is still an import-time
  singleton with no per-module schema); migrations (fragments + an ordered
  manifest, but one static list rather than per-module contributions);
  adapters (open `Platform`, capability-derived tool availability enforced at
  startup — but the descriptor and factory lists are static and `create()`
  still reads the config singleton).
- **Not started**: moderation policy, digest/queue registries, ingest sources
  and refresh topics, per-credential secret registration.

### What Phase 3 has done here

First: the parts that did not depend on the final `src/base/` boundary — the
package skeleton and lint/format/typecheck ratchet, the two gate scripts
(generalised to multi-root layouts, with their own tests), CI running the full
gate set, the cross-repo canary, `docs/MODULE-API.md`, and `template/`.

Then the lift itself: `src/base/**` moved into `src/**` with the SQL fragments,
`check-dist-schema.mjs`, and the tests that exercise base only; the
community-flavoured VALUES the split left behind (locale literals, the pinned
timezone, the vendor URL defaults, the community field names) were removed as
part of the move; and `createAgent({ modules })` was written, so composition is
an ordered, fail-closed call rather than an import list.

Then the publishing story: `package.json` made publish-ready (`0.1.0`, the
`files` allowlist verified against a real `npm pack`, `publishConfig` pointed
at public npm) and a tag-triggered publish workflow that runs the full gate,
refuses a tag that disagrees with `package.json`, and attaches build
provenance. Nothing is published yet — see [`RELEASING.md`](RELEASING.md) for
the owner-only prerequisites that gate the first release.

Still to come: the pipeline as reusable workflows, the consumer-side follow-up
in community-agent that makes the canary meaningful, and the 0.1.0 tag itself
once that is green.

## Contract stability

The module API here is **v0 and expected to move**. While Phase 1 is
underway, `community-agent` is authoritative: when a seam lands there with a
different shape than this contract guessed, the contract changes to match
(same-diff where practical). Consumers other than community-agent should not
build against this package before Phase 3 tags a 0.1.0.

## Phase 0 decisions of record

- **Distribution**: npm package(s) published to **public npmjs.com**, plus the
  pipeline as reusable workflows in this repo; per-repo state
  (security-floor manifest, tests-include ratchet, module map, VISION.md,
  theme labels, CI dummy env, governance-path list) stays per-repo.

  _Amended._ This decision originally read "GitHub Packages", and is now
  **overruled in favour of public npm**. GitHub Packages' npm registry requires
  an authenticated token to _install_, even for a public package — so every
  consumer, including the production deploy host, would need a credential (and
  a credential expiry) sitting in the path of `npm ci`. That is a fragile place
  for an auth step: the moment it bites is a 2am redeploy. Public npm needs no
  auth on any consumer at all, and confines the secret to the one publishing
  workflow. The mechanism is
  [`.github/workflows/publish.yml`](../.github/workflows/publish.yml); the
  procedure, and the owner-only prerequisites that gate the first release, are
  in [`RELEASING.md`](RELEASING.md).
- **Namespacing**: the MCP server key / `mcp__<ns>__` prefix is a module
  property (`AgentModule.name`), not a hardcoded literal.
- **DB naming**: physical table names (e.g. `community_users`) are kept for
  production compatibility; base docs/APIs use neutral names only.
- **`whats_new`/changelog**: base capability, opt-in per agent.
- **Platform set**: open string + adapter registration, never a closed union.
