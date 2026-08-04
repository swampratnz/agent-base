# Releasing `@swampratnz/agent-base`

How a human cuts a release of this package, and what a consumer has to do to
pick it up. For where the extraction stands see [ROADMAP.md](ROADMAP.md); for
the gate you run before any PR see [STANDARDS.md](STANDARDS.md).

## Where it publishes, and why

**Public npmjs.com.** Not GitHub Packages, which is what the Phase 0 note
originally recorded.

GitHub Packages' npm registry requires an authenticated token to _install_,
even for a public package. That would put a credential — and a credential
expiry — between the production deploy host and `npm ci`, i.e. directly in the
path of a 2am redeploy. Public npm requires no auth on any consumer: a fresh
box installs the framework with nothing configured, no `.npmrc`, no token.

## How it authenticates: trusted publishing, no token

Releases publish through **trusted publishing** (OIDC). There is **no
`NPM_TOKEN`, no `NODE_AUTH_TOKEN`, and no npm secret in this repository at
all** — if you are looking for where the token is configured, that is the
answer: there isn't one, and there should not be.

Instead, the workflow exchanges a short-lived GitHub OIDC token for a publish
grant that npm has pre-authorised against this exact **repository** and this
exact **workflow filename**. npm now warns against long-lived automation tokens
and steers to this, for the obvious reason: a leaked automation token publishes
from anywhere, forever, until somebody notices; an OIDC exchange is minted per
run, expires in minutes, and is useless outside `publish.yml` in this repo.

Three consequences worth internalising:

- **Renaming `publish.yml` breaks publishing** until the setting on npmjs.com
  is updated to match. The publisher is registered by filename.
- **Provenance is automatic.** npm generates and publishes the attestation for
  a trusted-publishing release by default; the workflow deliberately does _not_
  pass `--provenance`, because it is redundant.
- **There are hard toolchain floors**: npm CLI **>= 11.5.1** and Node
  **>= 22.14.0** (<https://docs.npmjs.com/trusted-publishers>). The workflow
  upgrades npm explicitly and then asserts both, because an older npm has no
  OIDC support and fails with an authentication error that reads exactly like a
  misconfigured publisher on npmjs.com.

> **The bootstrap is done.** npm will not configure a trusted publisher for a
> package that does not exist, so `0.1.0` was published by hand on 2026-08-03,
> the publisher was configured against it, and `0.1.1` went out through the
> workflow the same day. Nothing below needs doing again — the historical note
> is kept only so the ordering is not re-derived. See
> [First release (historical)](#first-release-historical).

The mechanism is [`.github/workflows/publish.yml`](../.github/workflows/publish.yml),
whose header comment is the authority on what it actually does; this page is
the procedure around it.

---

## Prerequisites (one-time, owner only — all done)

None of these can be done by CI or by an agent, and all four are complete. They
are recorded because each is a thing that can be *undone* by accident, and the
symptom is a dead release rather than an obvious mistake.

### 1. Licence — done

The package is **MIT**: `package.json` carries `"license": "MIT"` and the
repository root has the matching `LICENSE` file, which `npm pack` includes
automatically (it does not need to be listed in `files`).

Nothing to do here unless the terms change. If they ever do, both must move
together — the publish preflight fails when `license` is unset or
`UNLICENSED`, and separately when no `LICENSE` file exists to ship alongside
the declared identifier, on the dry-run path as well as the real one.

### 2. An npm account that owns the `@swampratnz` scope

`swampratnz` is a **user account**, so `@swampratnz` is that user's personal
scope and already exists. Publishing a scoped package under it works once you
are logged in as that user; the scope needs no separate setup.

`@swampratnz/agent-base` is **on the registry** — the bootstrap publish claimed
the name on 2026-08-03.

**Keep 2FA enabled** on that account. The old reason to weaken it was CI
publishing — an interactive OTP prompt cannot be answered by a workflow, which
is what pushed people to automation tokens and to turning 2FA off for
publishing. Trusted publishing removes that pressure entirely: the workflow
never logs in, so 2FA now only ever guards a human at a keyboard, which is
exactly where you want it.

### 3. There is no `NPM_TOKEN` — do not create one

This used to be a prerequisite. **It is not any more, and adding one would be a
step backwards.** The workflow reads no npm secret, and nothing in this
repository should hold one. If an `NPM_TOKEN` secret already exists here from
an earlier attempt, delete it: an unused long-lived publish credential is pure
liability.

The only credential in the release path is the per-run OIDC token GitHub mints
from the workflow's `id-token: write` permission, and it never leaves the
runner.

### 4. The trusted publisher — configured

On <https://www.npmjs.com/package/@swampratnz/agent-base> → **Settings** →
**Trusted publisher** → GitHub Actions:

| Field                     | Value                                                    |
| ------------------------- | -------------------------------------------------------- |
| Organization or user      | `swampratnz`                                              |
| Repository                | `agent-base`                                              |
| Workflow filename         | `publish.yml`                                             |
| Environment name          | _blank_ (this workflow uses no GitHub environment)         |
| Allowed actions           | **`npm publish`**                                        |

The workflow filename is the field people get wrong: it is the **filename
only, with its extension** — `publish.yml`, **not**
`.github/workflows/publish.yml`. A path there produces an authentication
failure that looks nothing like a naming mistake. It is also why renaming the
workflow file breaks every release until this setting is updated.

---

## First release (historical)

Kept short, and kept only so nobody re-derives the ordering or, worse, re-runs
a manual publish. **This does not apply again.**

npm's trusted-publisher setting lives on a package's own settings page and the
UI only offers it for a package that already exists
([npm/cli#8544](https://github.com/npm/cli/issues/8544)), so the sequence was
forced: `0.1.0` was published by hand from a clean checkout of the tag on
2026-08-03, the trusted publisher was configured against the now-existing
package, and `0.1.1` went out through the workflow with no credential anywhere
— which is what proved the path.

Two consequences that survive:

- **`0.1.0` carries no provenance attestation.** It came from a laptop, not
  CI. Every release from `0.1.1` on has one.
- The tag `v0.1.0`'s workflow runs **failed at `npm publish`**, by design, and
  they are still in the Actions history. That is not a regression to chase.

Everything from here is the normal procedure below.

---

## Cutting a release

### Step 0 — dry run first

The dry-run path runs **everything**: every gate, the tarball-contents check,
and `npm publish --dry-run`. It does not authenticate at all, so it can be run
against any branch, at any time, for free.

**Actions → Publish to npm → Run workflow**, leave `dry_run` at its default
(`true`). Read the job summary: it lists the tarball's top-level entries and
the SQL-fragment count.

What a dry run therefore cannot exercise is the OIDC exchange itself. Only a
real release does that.

### Step 1 — bump the version

[Semver](https://semver.org). The contract is **v0 and expected to move**
(see ROADMAP.md's _Contract stability_), so while the major is `0`, a breaking
change to the module API is a **minor** bump.

```bash
npm version 0.1.2 --no-git-tag-version
```

`--no-git-tag-version` on purpose: the version bump goes through a PR like any
other change, and the tag comes afterwards, off the merged commit. A tag on an
unmerged commit is how you end up publishing a tree `main` does not have.

Use `npm version` rather than `npm pkg set version` or a hand-edit: it writes
**`package-lock.json` as well**, and `npm ci` refuses a tree where the two
disagree. CI will not catch that for you — this job upgrades npm to a
trusted-publishing-capable version, which enforces the check, while `ci.yml`
uses the runner's bundled npm, which does not. The publish preflight asserts
it, so the failure is a one-line message rather than a dead release.

### Step 2 — merge it

Open the PR, let CI go green, merge to `main`. Nothing publishes yet.

### Step 3 — tag and push

From the merged commit on `main`:

```bash
git checkout main && git pull
git tag -a v0.1.2 -m 'agent-base 0.1.2'
git push origin v0.1.2
```

The tag **must** be `v` + the exact `package.json` version. The workflow
compares them and refuses a mismatch — that is the classic release footgun
(tag `v0.2.0` pushed while `package.json` still says `0.1.1`), and npm would
otherwise cheerfully publish something the tag does not name.

Pushing the tag is what triggers the publish. There is no other trigger for a
real publish: a manual run with `dry_run: false` from a branch is rejected,
because it would publish an untagged tree.

### What the workflow does

That is the whole procedure — bump, commit, tag, push. **No token is created,
rotated, or entered anywhere**, and nothing else is manual.

The workflow, in one job, in this order:

1. **Toolchain** — `actions/setup-node` with
   `registry-url: https://registry.npmjs.org` and `package-manager-cache: false`
   (npm's own guidance: never cache in a release build), then an explicit
   `npm install -g 'npm@^11.5.1'` — **pinned to the 11.x line, not `@latest`**.
   npm 12 disables git-protocol dependencies by default and this tree has one
   transitively (`libsignal`, via `@whiskeysockets/baileys`), so `npm ci` fails
   with `EALLOWGIT` there. `@latest` also meant the release path adopted npm's
   breaking default changes on npm's schedule rather than ours, invisibly:
   `ci.yml` uses the runner's bundled npm and never sees them.
2. **Preflight** — asserts npm >= 11.5.1 **and < 12.0.0** and Node >= 22.14.0; refuses
   `private: true`; refuses a missing `license` field _or_ a missing `LICENSE`
   file; checks the tag shape and that it matches `package.json`; and, for a
   real publish, checks a GitHub OIDC token is actually available to the job.
   All of it before any long step, so a mistake costs seconds rather than
   twenty minutes.
3. **The full gate** — `typecheck`, `lint`, `format:check`, `context:check`,
   `migrate`, `test` (against the same `pgvector/pgvector:pg16` service
   container CI uses), `test:security`, `build`. A tag can point at any commit,
   including one that never went through a PR, so the gate runs here regardless
   of what CI said on `main`.
4. **Pack and verify** — packs the tarball and asserts it actually contains
   `dist/index.js`, `dist/index.d.ts`, `dist/storage/migrate.js`, both gate
   scripts, and **every** `storage/schema/*.sql` fragment. `files` in
   `package.json` is an allowlist, so its failure mode is silent omission; a
   package that installs but cannot migrate is broken in a way no unit test
   sees.
5. **Publish** — `npm publish --access public`, authenticated by the OIDC
   exchange. No `env:` block, no token.

### Provenance

Provenance is **automatic** and needs no flag: npm generates and publishes an
attestation for every trusted-publishing release, naming this repository,
workflow and commit. Consumers verify it with `npm audit signatures`, and
npmjs.com shows a **Provenance** panel on the package page.

It requires a **public** source repository, which `swampratnz/agent-base` is —
confirmed against the GitHub API when the workflow was written — plus
`id-token: write`, granted at the job level only.

Two honest caveats:

- **`0.1.0` has no provenance**, because that one publish came from a laptop
  rather than CI. Every release from `0.1.1` onward carries one.
- The **dry-run path does not authenticate**, so it exercises neither the OIDC
  exchange nor the attestation. Both were first exercised by the `0.1.1`
  publish, which is the run to compare against if a later one misbehaves.

### When a release fails to authenticate

Symptoms are an npm authentication error at the publish step. In order of
likelihood:

- **The trusted publisher setting was changed or removed** — check it against the table in Prerequisites 4. This is the likeliest cause, because it is the only part of the release path that lives outside this repository.
- **Workflow filename mismatch** — the npmjs setting must read `publish.yml`,
  the filename alone with its extension, not a path.
- **`id-token: write` was removed or narrowed**, at the job, the repo, or the
  org. The preflight catches this one before the gates run.
- **npm too old** — also caught in preflight, with the version printed.

---

## Verifying a published release

```bash
V=0.1.1   # the version you just released

# 1. the registry has it, with the right files and no auth involved
npm view "@swampratnz/agent-base@$V"

# 2. a clean consumer install — no .npmrc, no token, no login
mkdir /tmp/verify && cd /tmp/verify && npm init -y >/dev/null
npm install "@swampratnz/agent-base@$V"

# 3. the two things that make it usable at all
node -e 'import("@swampratnz/agent-base").then(m => console.log(Object.keys(m)))'
ls node_modules/@swampratnz/agent-base/dist/storage/schema/*.sql | wc -l   # expect 26

# 4. provenance
npm audit signatures
```

Step 2 is the one that matters most: it is the deploy host's experience, and
the entire reason for choosing public npm over GitHub Packages. If it asks for
credentials, something is wrong with `publishConfig.access` — check
<https://www.npmjs.com/package/@swampratnz/agent-base> is publicly visible, and
`npm access list packages @swampratnz` from the owning account.

---

## Fixing a bad release

**npm versions are immutable.** You cannot re-publish `0.1.0` with different
contents; the remedy is always a new version.

All three commands below are **human, interactive** operations: trusted
publishing covers `npm publish` and nothing else, so `deprecate`, `dist-tag`
and `unpublish` need an `npm login` at a keyboard (2FA prompt included). That
is the right shape — none of them should ever be reachable from CI.

### Preferred: deprecate and supersede

```bash
npm deprecate @swampratnz/agent-base@0.1.0 "Broken migrate path; use 0.1.1."
# then bump, merge and tag 0.1.1 exactly as above
```

`npm deprecate` leaves the version installable (so nothing already pinned to it
breaks) but prints the message on every install. This is almost always the
right call.

If the bad version became `latest` and you need to point `latest` back at a
known-good one while the fix is prepared:

```bash
npm dist-tag add @swampratnz/agent-base@0.0.9 latest
```

### Last resort: unpublish

npm's unpublish policy is narrow, and deliberately. Within **72 hours** of
publishing, a version can be removed outright. After that, npm only allows it
when the package has no dependents in the registry, has very little recent
download traffic, and has a single owner — otherwise you are asking npm support
to make an exception, and they will generally say "deprecate instead". Read
<https://docs.npmjs.com/policies/unpublish> before relying on any of this; the
thresholds are npm's to change.

```bash
npm unpublish @swampratnz/agent-base@0.1.0
```

Note that unpublishing **burns the version number forever** — you cannot
republish `0.1.0` afterwards. Prefer `deprecate` unless the published tarball
contains something that must not exist (a leaked secret being the obvious one,
in which case rotate the credential first: unpublishing does not un-leak it).

---

## The consumer side

### Installing

```bash
npm install @swampratnz/agent-base
```

**No authentication, no `.npmrc`, no registry configuration** — that is the
whole point of the registry decision. A deploy host needs nothing beyond
network access to `registry.npmjs.org`.

### Importing

The package exports the barrel **and its whole compiled tree**:

```ts
// The barrel: createAgent, the module manifest type, the notice catalogue,
// migrate, the schema manifest.
import { createAgent, type AgentModuleManifest } from '@swampratnz/agent-base';

// Any module, by its source path with a `.js` extension — the same specifier
// shape this repo uses internally.
import { Router } from '@swampratnz/agent-base/router.js';
import { runAgentTurn } from '@swampratnz/agent-base/agent/core.js';
import { listAdminDisplayNames } from '@swampratnz/agent-base/storage/repository.js';
import type { PlatformAdapter } from '@swampratnz/agent-base/platforms/types.js';
```

The extensionless form (`@swampratnz/agent-base/router`) resolves to the same
module. Both carry types under `moduleResolution` `bundler`, `node16` and
`nodenext`; the deprecated `node10` algorithm ignores `exports` entirely and
cannot see either form.

Two wildcards in `package.json` do this (`./*.js` and `./*`, both onto
`./dist/*`), rather than an enumeration, because an enumeration silently omits
every module added after it was written. `0.1.0` published neither, which made
the package undependable for anything past the barrel — see
[the exports comment in `package.json`](../package.json) and
`tests/packageExports.test.ts`, which pins that every module under `src/` is
addressable.

**ESM only, but resolvable from either loader.** The package ships one
artifact and it is ESM — that has not changed. What changed is what the map
*says* when something asks for it under another condition. Through the
published `0.1.1` every entry declared `types` and `import` and nothing else, so a
`require` resolution got `ERR_PACKAGE_PATH_NOT_EXPORTED` — an error that names
the wrong problem, since the subpath *is* exported and is merely ESM-shaped.
It first bit `createRequire(...).resolve('@swampratnz/agent-base/…')` inside a
test that only wanted a file path (issue #11; `import.meta.resolve` is the
right answer there and is what the consumer switched to).

Each entry now ends in a `default` catch-all. Deliberately `default` and not
`require`: a `require` key is a promise of a CommonJS artifact, and pointing it
at an ESM file would state something false in the one place a bundler trusts
most. `default` states what is true — one artifact, offered under every
condition — and lets the loader decide. On the Node this package supports
(`engines: >=22`; `require()` of ESM is unflagged from 22.12) such a call now
resolves and works; on an older loader it fails as `ERR_REQUIRE_ESM`, which
names the real constraint. `default` must be declared LAST, because conditions
are matched in declaration order — `tests/packageExports.test.ts` pins that,
and asks Node's own resolver under both conditions rather than only
re-implementing the pattern matching.

### The canary

[`canary-community-agent.yml`](../.github/workflows/canary-community-agent.yml)
builds `community-agent` against **this repo's HEAD** by `npm pack`ing it and
installing the local tarball. That mechanism is unchanged by publishing and
must stay: it is what closes the window in which HEAD here is silently
incompatible with the only consumer, and it works on commits that were never
published.

It is gated behind a repository **variable**, which is now **on**:

- **Settings → Secrets and variables → Actions → Variables**
- `AGENT_BASE_CANARY_ENABLED` = `true`

So it runs on its daily `37 14 * * *` cron and a red run is real signal about
this repo's HEAD, not the known-premature noise it would have been before the
consumer took the dependency. A manual run with `force: true` bypasses the
variable; turning the variable off is the off switch if the consumer is ever
mid-migration.

Now that versions are published, testing the **published** artifact as well as
HEAD is possible — a second job, or an input naming a version instead of the
local tarball. It would catch a packaging fault the local pack cannot see,
which is exactly the class `0.1.0`'s missing subpath exports fell into. Still
an optional extra, never a replacement: the local-tarball path is the one that
catches a break before it ships.
