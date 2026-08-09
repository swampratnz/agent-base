# Roadmap

The full extraction plan — including the complete base/community
classification of the source codebase, the coupling analysis, and the
per-phase risks — lives in
[`community-agent`'s docs/AGENT-BASE-PLAN.md](https://github.com/swampratnz/community-agent/blob/main/docs/AGENT-BASE-PLAN.md)
(community-agent PR #949). This file tracks where the work stands from this
repo's side.

## Strategy

**Strangle in place, extract last.** The runtime seams were reified inside
`community-agent` first, where its ~200 test files, security-test floor and
pipeline adjudicated every step. This repo started as the _contract_ those
refactors coded against, then received the runtime by extraction — never by
greenfield rewrite. That extraction has landed and the package is published, so
the strategy question now is the reverse one: a base change is made here and
reaches the consumer as a version bump.

## Phases

| Phase | What                                                                                                                                                        | Where           | Status               |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | -------------------- |
| 0     | Decisions: distribution (npm + reusable workflows), naming, module API v0                                                                                   | here            | **done** — this seed |
| 1     | Reify the seams: tool registry, config slices, storage fragments + hooks, job registry, strings catalogue, router intercepts, prompt slots, adapter factory | community-agent | **landed**, and lifted here |
| 2     | Two packages in one repo (`src/base/` / `src/module/`), one-way import rule                                                                                 | community-agent | **done, then superseded** — the split landed and the extraction then removed `src/base/` entirely; the one-way gate now enforces that it stays gone |
| 3     | Extract: runtime packages, gate scripts, pipeline as reusable workflows, repo template                                                                      | here            | **largely done** — runtime, gates and template shipped, `0.1.0`/`0.1.1`/`0.2.0`/`0.3.0` published; the pipeline as reusable workflows has not started |
| 4     | Prove the seams: scaffold the personal/household agent from the template — [**PHASE-4-PERSONAL-AGENT.md**](PHASE-4-PERSONAL-AGENT.md)                       | new repo        | planned              |

### Where the seams actually stand

Read from `src/` rather than from anyone's status report.
`docs/MODULE-API.md` has the signatures and the full breakdown; in summary:

- **Live** — a module supplies these through the `AgentModule` manifest and
  `createAgent` registers them: tool-server parts, tool tiers and feature-flag
  predicates; the notice pack (with open locale axes); prompt sections (a
  **closed** slot set); personas; the skills manifest; commands; the default
  moderation term list; policy keys; provenance→trust; purge contributors and
  the other storage lifecycle hooks; pre-turn intercepts, post-turn handlers
  and turn-state finalizers; and schema fragments.
- **Partial** — the mechanism is base's but the wiring is still the
  composition root's, not a manifest field: config (per-domain slices, and a
  boot slice that lets `migrate` run on `DATABASE_URL` alone, but `config` is
  an import-time singleton with no per-module schema); jobs (`JobSpec` and the
  start/stop sweeps, but the list is passed to `startRegisteredJobs`);
  adapters (open `Platform`, capability-derived availability — but the
  descriptor and factory lists are static and `create()` reads the config
  singleton).
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

Then the publishing story: MIT licensing, `package.json` made publish-ready
(the `files` allowlist verified against a real `npm pack`, `publishConfig`
pointed at public npm) and a tag-triggered publish workflow that runs the full
gate, refuses a tag that disagrees with `package.json`, and authenticates by
**trusted publishing (OIDC)** — no npm token exists in this repository at all,
and provenance is generated automatically.

**`0.1.0` shipped on 2026-08-03**, by hand, because npm will not configure a
trusted publisher for a package that does not exist. The publisher was then
configured against it and **`0.1.1` shipped through the workflow the same day**,
which is what proved the credential-free path end to end. `0.1.1` exists
because the first real consumer found two blockers in `0.1.0`: the subpath
exports were missing, so nothing past the barrel was importable, and
`toolServerParts` was typed `ToolServerParts<never>`, which no module could
satisfy. See [`RELEASING.md`](RELEASING.md).

Then the consumer flip: community-agent deleted its `src/base/`, took the
dependency, and composed through `createAgent`. The canary is on and green.

Still to come: the pipeline as reusable workflows (this repo ships none today —
only `ci.yml`, `publish.yml`, the canary and `consumption.yml`), and Phase 4.

### Phase 4 is planned, and it names two seams to close

[PHASE-4-PERSONAL-AGENT.md](PHASE-4-PERSONAL-AGENT.md) is the build plan for
the second consumer — a two-person household agent over WhatsApp, with
calendars, mail, lists and read-only finance. It is worth reading from this
repo's side for what it found, which is the point of having a second consumer
at all: a deployment whose users are **two maximally-trusted people** rather
than many low-trust ones stops using the tier lattice as its real boundary, and
lands on two `planned` seams almost immediately.

- **`configSchema`** blocks it at day one. A module cannot declare an env var,
  so a consumer's OAuth credentials would have to become fields in a slice
  *here* — in the framework that is supposed to be domain-agnostic. There is a
  workable interim (parse your own env in `init()`, which keeps the fail-fast
  property), so this is a Phase-2-of-that-build item, not a prerequisite.
- **`registerRuntimeSecret`** was the sharper one and the smaller fix, and it
  has since **landed**: `AgentModule.runtimeSecrets` registers per-credential
  getters into the exact-value redaction backstop every adapter send path
  applies. A consumer holding OAuth refresh tokens for two mailboxes needed
  this before its first token existed, and now has it.

Both are already marked `planned` in [MODULE-API.md](MODULE-API.md); what Phase
4 adds is a consumer that makes them concrete rather than theoretical.

**Measured, and it revises the Phase 0 wording.** community-agent's nine
pipeline workflows are ~3,700 lines, of which the deterministic no-LLM ones
(auto-merge, groundskeeper, build-retry, ci-retry, outcomes) are ~840 and the
LLM loops ~2,845 — and the latter are mostly prompt text tuned per repo. So
about a quarter is genuinely reusable as a workflow and the rest is a template
someone adapts. See [PIPELINE.md](PIPELINE.md), which also argues that porting
the loops is the SECOND thing to automate here: the first is a release-
confidence layer, because every defect that has reached a published artifact so
far was in build/release machinery and invisible to a green CI run.

## Contract stability

The module API is **v0 and expected to move**. `0.1.x` is published and
installable, and a second consumer is welcome to build against it — but while
the major is `0`, a breaking change to the module API is a **minor** bump, and
there will be some. The first was issue #10: the barrel used to export the v0
contract types in `src/module-api/` alongside the live ones, which meant two
different `AgentModule`s and a `ToolDef` the tool server would reject.
Reconciling toward the live types removed those exports outright — a breaking
change by construction, and invisible to the one existing consumer, which
imported the live types by their deep paths. Pin an exact version if that
matters to you.

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
  auth on any consumer at all.

- **Publish authentication**: **trusted publishing (OIDC)**, not an npm
  automation token. npm now warns against long-lived tokens, and the difference
  is the blast radius: a leaked automation token publishes from anywhere until
  someone notices, whereas an OIDC grant is minted per run, expires in minutes,
  and is bound to this repository AND this workflow filename. Consequently this
  repository holds **no npm secret of any kind**, provenance attestations come
  automatically, and the toolchain floors (npm >= 11.5.1, Node >= 22.14.0) are
  asserted in the workflow rather than assumed. One wrinkle to know: npm cannot
  pre-authorise a publisher for a package that does not exist, so the first
  release is a one-time manual publish and everything after it is credential-free.
  The mechanism is
  [`.github/workflows/publish.yml`](../.github/workflows/publish.yml); the
  procedure, the bootstrap, and the owner-only prerequisites are in
  [`RELEASING.md`](RELEASING.md).
- **Namespacing**: the MCP server key / `mcp__<ns>__` prefix is a module
  property (`AgentModule.name`), not a hardcoded literal.
- **DB naming**: physical table names (e.g. `community_users`) are kept for
  production compatibility; base docs/APIs use neutral names only.
- **`whats_new`/changelog**: base capability, opt-in per agent.
- **Platform set**: open string + adapter registration, never a closed union.
