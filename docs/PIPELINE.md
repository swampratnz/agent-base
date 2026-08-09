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

### The loops, and what each needs

The nine workflows split into two kinds. This matters for porting, because only
one kind is a find-and-replace.

| Loop | Kind | Trigger | Ports as |
|---|---|---|---|
| research | LLM | cron | needs a new prompt — see below |
| adversarial | LLM | `status:draft` label | prompt largely portable |
| build | LLM | `status:approved` label | **prompt needs the gate list rewritten** |
| pr-review | LLM | PR opened / synchronize | prompt largely portable |
| pr-autofix | LLM | CI failure, `run_attempt` ≥ 2 | prompt largely portable |
| pr-revise | LLM | review verdict, self-dispatch | prompt largely portable |
| pr-conflict | LLM | push to main, hourly sweep | prompt largely portable |
| ci-retry | deterministic | CI failure, `run_attempt` < 2 | **verbatim** |
| build-retry | deterministic | build run failed | **verbatim** |
| groundskeeper | deterministic | hourly | **verbatim** |
| pr-automerge | deterministic | PR events | verbatim, but see Open decisions |
| outcomes | deterministic | scheduled | verbatim |

### The label state machine

Coordination is entirely through issue labels — there is no session-to-session
channel; the repository is the bus. The set community-agent uses, minus its
`theme:*` axis:

```
research ──▶ [proposal, status:draft]
                    │
adversarial ──▶ status:approved   |   status:rejected (closed)
                    │
build ──▶ status:building ──▶ branch + PR "Closes #N" ──▶ status:built
                    │
pr-review ──▶ approve | request changes
                    │
              ⟶  merge  ⟵
```

| Label | Meaning |
|---|---|
| `proposal` | this issue is a proposal |
| `status:draft` | awaiting adversarial review |
| `status:approved` | buildable — **the build worker triggers on this label event** |
| `status:rejected` | failed review (issue closed) |
| `status:building` | claimed by a build run |
| `status:built` | PR open, awaiting review/merge |
| `needs-human` | escalated; a **lane**, not a flag — the item leaves the automated queue |
| `no-auto-merge` / `no-auto-resolve` | pin a PR out of a loop |
| `human-merge-ready` | governance-path PR that passed everything else |

`theme:*` is a diversity axis on proposals, and community-agent's values
(`theme:knowledge`, `theme:moderation`, `theme:onboarding`, …) are its own. This
repository's axis should be [VISION.md](VISION.md)'s ranked proposal sources —
`theme:consumer-friction`, `theme:contract-gap`, `theme:release-confidence` —
because that ordering is what a framework's research should be weighted by.

### Required repository inputs

| Input | Kind | Status here |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | secret | **not set** — every LLM loop gates on it being non-empty and skips silently otherwise |
| `GITHUB_TOKEN` | automatic | fine |
| `AUTOMERGE_MODE` | variable | n/a until auto-merge is decided |
| `MAINTAINER_LOGINS` | inline in the conflict resolver | `swampratnz`, unchanged |
| the label set above | labels | **absent** — `status:approved` 404s today |
| a governance-path list | inline in auto-merge | must be rewritten: this repo's is `.github/`, `scripts/`, `package.json`, `CLAUDE.md`, `docs/SECURITY.md`, `docs/VISION.md`, and **`publish.yml` above all** |

---

## Would it work today?

Checked rather than assumed, because "documented" and "would run" are different
claims and only one of them is cheap.

| # | Finding | Severity |
|---|---|---|
| 1 | **No labels.** `status:approved` does not exist, and the build worker triggers on `label` events for exactly that name. Nothing could ever start. There is no `setup-labels.yml`/`scripts/setup-labels.sh` here either. | blocker, trivial fix |
| 2 | **No `CLAUDE_CODE_OAUTH_TOKEN`.** Every LLM loop checks `secrets.CLAUDE_CODE_OAUTH_TOKEN != ''` and no-ops when empty — so a port would appear installed and do nothing, which is worse than failing. | blocker, trivial fix |
| 3 | **The build worker's gate no longer equals CI.** See below. | ~~blocker, real work~~ **fixed** — issue #35, `npm run test:consumption` |
| 4 | `imports:check` is named in the build worker's prompt and does not exist here (deliberately — see CLAUDE.md). A ported prompt would instruct an agent to run a missing script. | small |
| 5 | `theme:*` values are community-specific and would seed a framework's research with a consumer's categories. | small |
| 6 | Two-repo changes still have no mechanism. | design work |

### Finding 3, because it is the one that is new

community-agent's rule, in its `CLAUDE.md`:

> the build worker runs the **full CI gate** … BEFORE opening a PR, so "green
> locally" matches CI. Keep it that way when editing either `pipeline-build.yml`
> or `ci.yml` — they must run the same checks.

That worked because its whole gate is a list of `npm run …` commands, and its
`ci.yml` runs exactly those.

**That equivalence broke here when Layer 1 landed, and issue #35 restored it.**
Layer 1 added `consumption.yml` — five jobs across two workflows — and promoted
the canary to a PR gate, none of it reachable by `npm run …`. A build worker
would have run the npm gates, correctly believed it was green, opened a PR, and
then discovered Consumption or Canary red — precisely the "green locally, red
in CI" loop the rule exists to prevent, and the loop most likely to burn a
retry budget.

The fix was to make the sequence runnable, not to weaken the rule: the
consumption test now lives in `scripts/consumption-test.mjs`, exposed as
`npm run test:consumption`, and `consumption.yml`'s `consume` job invokes that
script rather than inline bash. The gate list is a list of npm scripts again,
a build worker can run it, and a contributor gets the same check locally —
the same principle that put every other gate behind an npm script. The
cross-platform and toolchain matrices stay workflow-level by nature, and the
honest answer there is that a build worker cannot reproduce them, so they
should be understood as post-merge signals rather than pre-PR ones — the same
goes for the canary.

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
