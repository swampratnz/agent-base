# Automating this repository

What automation this repository should grow, in what order, and why the answer
is not "copy community-agent's pipeline".

community-agent is developed by a supervised multi-loop Claude Code pipeline —
nine workflows, ~3,700 lines, documented in
[its `docs/PIPELINE.md`](https://github.com/swampratnz/community-agent/blob/main/docs/PIPELINE.md).
That pipeline works, and most of it is portable. This document argues that
porting it is the **second** thing to do here, not the first.

---

## Where the automation stands today

| Workflow | What it does |
|---|---|
| `ci.yml` | three jobs — `build` (typecheck, migrate, test against a real pgvector Postgres, build), `lint` (lint, format:check, context:check), `security-invariants` (`test:security`) |
| `publish.yml` | fires on a `v*.*.*` tag; re-runs the whole gate, then publishes to npm by OIDC trusted publishing. No token exists in this repository |
| `canary-community-agent.yml` | daily: builds this commit, packs it, installs the tarball into a community-agent checkout, runs that repo's gate |

No labels, no `VISION.md`, no agent loops. Releases are cut by hand and should
stay that way — see [RELEASING.md](RELEASING.md).

---

## The asymmetry

community-agent's pipeline merges into **a deployment**. A bad merge is a
revert, and one Discord server has a bad hour.

This repository's automation would merge into **an artifact other people
install**. A bad merge that reaches a tag burns an npm version permanently —
npm versions are immutable, and the remedy is always a new version — and every
consumer inherits it.

Same machinery, different blast radius. Two consequences shape everything
below:

1. **Merge is not ship, and must stay that way.** The tag is a deliberate human
   act, and `publish.yml` enforces it: a `workflow_dispatch` with
   `dry_run: false` from a branch is refused, because it would publish an
   untagged tree. No automation may relax that.
2. **The gate before a merge has to be stronger here**, because the gate after
   it is a human who may not look twice.

---

## What actually breaks, and why CI cannot see it

This is the load-bearing observation, and it is empirical rather than
theoretical. Over the extraction, the flip and the `0.1.x`/`0.2.0` releases,
**every defect that reached a published artifact or a broken boot was in build,
release or test machinery — and every one was invisible to a green CI run**:

| Defect | What it needed to be visible |
|---|---|
| `exports` map declared `{types, import}` only, so `require` resolution failed (#11) | a different **loader** |
| `package-lock.json` at `0.0.1` while `package.json` said `0.1.1` | a different **npm major** (11 enforces it, the runner's bundled 10 does not) |
| `cp` in the build script | a different **OS** |
| `npm@latest` resolving to 12, which blocks git-protocol deps | a different **npm major**, again |
| Slash commands bound at module scope, so the built app died on line one | **actually starting the program** |
| A gate test spawning a second test runner over one database (#18) | a **slower machine** |
| Tag pushes refused by a sandbox git credential | a different **credential scope** |
| `template/` pinning `^0.1.1`, which excludes `0.2.0` | **installing the package as a consumer would** |

Not one is a product bug. Not one would have been caught by running more tests
on the same machine, in the same shell, against the same tree. Each needed a
**condition CI does not produce**.

That is the thesis: for this repository, the automation worth building first is
not more agents writing features. It is automation that **manufactures the
conditions CI does not produce**. The agent loops are worth having, but they
generate more PRs against the same blind gate — which raises throughput and
raises the number of ways to ship something broken by exactly the same factor.

---

## Layer 1 — release confidence

Build this first. Each item exists because something in the table above got
past everything else.

### 1. The consumption test

Pack the tarball, scaffold `template/` into a temp directory, install the
tarball into it, and run **that repo's own gate** (`typecheck`, `lint`,
`test`, `build`, `test:security`, `context:check`).

This is the highest-value item on the page and it subsumes several others. It
exercises the package the way the only thing that matters exercises it — a
consumer installing it — and it would have caught the exports-map gap, a
missing `files` entry, a missing schema fragment, and the `template/` version
pin, none of which any test in this repository can see. `template/` is
deliberately outside lint, Prettier and both tsconfigs, so today **nothing
checks it at all**; this becomes its only gate as well.

Note it must install a **packed tarball**, never a workspace link. A link
resolves through the source tree and hides precisely the `exports`/`files`
questions being asked.

### 2. Boot smoke

Build, then actually start the artifact with a minimal env and assert it
reaches a ready state.

2,830 tests passed on a tree whose `dist/index.js` threw on the first
registration read. The suite exercised every unit and never once ran the
composition. `template/`'s `main.ts` is the natural subject — it is small,
it is ours, and if it cannot boot, no scaffolded agent can.

### 3. Toolchain matrix

Run the pack-and-install path across npm majors (11, latest) and Node majors
(22, 24).

Two shipped defects came from npm-major differences alone, in opposite
directions: npm 10 not enforcing the lockfile pairing, npm 12 refusing a
git-protocol dependency. `ci.yml` uses whatever npm the runner bundles;
`publish.yml` pins `^11.5.1`. Nothing tests the range a consumer might have.

### 4. Cross-platform pack

Build and pack on Windows and macOS. Not the full suite — the DB-backed tests
would need service containers on both, which is not worth it — just the steps
that touch the filesystem and shell out.

`cp` in the build script only failed on a Windows laptop, after the tarball had
already been prepared for publication.

### 5. Canary as a gate

The canary already exists and already does the right thing. Today it is a
nightly cron: a red canary reports that `main` broke the consumer *after*
`main` broke the consumer.

Promote it to a required check on any PR touching the public surface
(`src/index.ts`, `package.json`'s `exports`/`files`, `src/module-api`'s
successors, anything under `scripts/`). It is the only mechanism that answers
"does this break the thing that installs it" before the merge rather than
after.

**Cost note.** Items 3 and 4 multiply job count. Scope them to the pack/install
path rather than the full suite, and consider running them on `main` and on
release-tagged PRs rather than on every push, if minutes become a problem.
Items 1, 2 and 5 are cheap and should run everywhere.

---

## Layer 2 — the agent loops

Worth having, after Layer 1 makes their output safe to accept. Most of
community-agent's pipeline ports directly: grepping the nine workflows for repo
coupling finds no hardcoded repository names or paths, one reference to
`imports:check` (inside a prompt, not a step), and `MAINTAINER_LOGINS` inline.
The only inputs are `CLAUDE_CODE_OAUTH_TOKEN`, the automatic `GITHUB_TOKEN`,
and an `AUTOMERGE_MODE` variable.

Three things genuinely differ here, and they are design work rather than
find-and-replace:

**The research loop has a different input.** community-agent's reads its
`docs/VISION.md` — a backlog of community features. A framework's equivalent is
not that, and this repository should not grow one: inventing extension points
nobody has asked for is how a base accumulates surface it cannot defend.

[VISION.md](VISION.md) is the version that fits, and it deliberately ends with
a ranked list of where proposals come from rather than a list of features:
consumer friction first (an issue in a consuming repo that turns out to be a
base problem — #9, #10, #11 and #29 all arrived that way), then the
contract-vs-code gaps in [MODULE-API.md](MODULE-API.md), then release-confidence
gaps, and speculative generality last. That ordering is the research loop's
prompt, near enough.

**Two-repo changes have no mechanism.** A base change that requires a consumer
change cannot be validated by either repository's CI alone. The canary is the
raw material for this, but the pipeline has no concept of a change that spans
both repositories, and inventing one is the hardest single piece of Layer 2.

**Done means a merged PR, never a release.** Same as today. No loop tags.

---

## Correction: "the pipeline as reusable workflows"

[ROADMAP.md](ROADMAP.md)'s Phase 0 records a decision to ship the pipeline from
this repository as reusable workflows. Measuring it changes the picture:

| | lines | reusable as a workflow? |
|---|---|---|
| Deterministic, no LLM — auto-merge, groundskeeper, build-retry, ci-retry, outcomes | ~840 | **Yes** |
| LLM loops — build, autofix, conflict, review, revise | ~2,845 | Mostly prompt text, tuned per repo |

So roughly a quarter is genuinely a reusable workflow; the rest is a template
someone adapts. That is worth writing down before someone plans a release
around "ship the pipeline", and it is why `template/` matters more to this
story than a `workflow_call` interface does.

---

## Open decisions

- **Auto-merge here: never, or eventually?** It is the most portable single
  workflow and the least obviously appropriate. In community-agent it exists
  because a backlog of green, approved PRs stalls on a human. This repository's
  merge rate is a fraction of that and the cost of a wrong merge is much
  higher — a merged PR is a candidate for an immutable published version.
  Unresolved; deliberately not built.
- **Where Layer 1 runs.** Every push, or `main` plus release PRs? Depends on
  how much CI time is acceptable.
- **Does `template/` get its own CI in this repository**, or is the consumption
  test (item 1) its only gate? Item 1 as written makes it the latter.
