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

> **The first release cannot use it.** npm will not let you configure a trusted
> publisher for a package that does not exist yet, so `v0.1.0` has to be
> published by hand, once. See
> [First release (one-time bootstrap)](#first-release-one-time-bootstrap).

The mechanism is [`.github/workflows/publish.yml`](../.github/workflows/publish.yml),
whose header comment is the authority on what it actually does; this page is
the procedure around it.

---

## Prerequisites (one-time, owner only)

None of these can be done by CI or by an agent. Do them in order — and note
that (4) is blocked until the [bootstrap publish](#first-release-one-time-bootstrap)
has happened, which is a property of npm, not an oversight here.

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

`@swampratnz/agent-base` itself is **not on the registry** — an unauthenticated
`GET` of `https://registry.npmjs.org/@swampratnz%2Fagent-base` returns 404, so
the name is free as of this writing and the bootstrap publish below is what
claims it.

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

### 4. Configure the trusted publisher — _after_ the bootstrap publish

npm cannot configure a trusted publisher for a package that does not exist yet,
so this step is genuinely blocked until
[the first release](#first-release-one-time-bootstrap) has happened. It is
listed here so the ordering is not a surprise.

---

## First release (one-time bootstrap)

**Read this before tagging `v0.1.0`.** The very first publish does **not** go
through the workflow.

npm's trusted-publisher setting lives on a package's own settings page, and the
npmjs.com UI only offers it for a package that already exists — there is no way
to pre-authorise a publisher for a name that has never been published
([npm/cli#8544](https://github.com/npm/cli/issues/8544), open at the time of
writing). So the sequence is unavoidable: publish `0.1.0` by hand, then
configure trusted publishing, then never touch a credential again.

A real run of the workflow before that bootstrap will pass every gate and then
fail at `npm publish`. That is expected, not a defect.

### Step 1 — tag as usual

Do the version bump, PR, merge and tag exactly as
[Cutting a release](#cutting-a-release) describes. The tag push will start the
workflow; let it run (it is a free full-gate check of the tagged tree) and
expect the publish step to fail.

### Step 2 — publish by hand, from a clean checkout of the tag

**Not from your working tree.** `npm publish` packs whatever is on disk, so a
stray edit, a leftover scratch file or a half-finished branch would be baked
into an immutable release. Clone fresh and check out the tag:

```bash
cd "$(mktemp -d)"
git clone --depth 1 --branch v0.1.0 https://github.com/swampratnz/agent-base.git
cd agent-base

# sanity: this must print exactly the tag you are releasing
git describe --exact-match --tags HEAD
node -p 'require("./package.json").version'

npm ci
npm run build            # prepublishOnly runs it too; running it here fails earlier
npm pack --dry-run       # eyeball the file list: dist/, scripts/, LICENSE, 26 *.sql

npm login                # interactive; answer the 2FA prompt
npm publish --access public
```

`--access public` is not optional for a first publish: a scoped package
defaults to **restricted**, and a restricted package is the auth-required
install this whole registry decision exists to avoid.

This publish will **not** carry a provenance attestation — provenance comes
from CI, and this one is a laptop. Every subsequent release gets one
automatically.

Then log the laptop back out, so no long-lived credential lingers:

```bash
npm logout
```

### Step 3 — configure the trusted publisher

On <https://www.npmjs.com/package/@swampratnz/agent-base> → **Settings** →
**Trusted publisher** → GitHub Actions. The fields, exactly:

| Field                     | Value                                                    |
| ------------------------- | -------------------------------------------------------- |
| Organization or user      | `swampratnz`                                              |
| Repository                | `agent-base`                                              |
| Workflow filename         | `publish.yml`                                             |
| Environment name          | _leave blank_ (this workflow uses no GitHub environment)   |
| Allowed actions           | select **`npm publish`**                                  |

The workflow filename is the field people get wrong: it is the **filename
only, with its extension** — `publish.yml`, **not**
`.github/workflows/publish.yml`. A path there produces an authentication
failure on the next release that looks nothing like a naming mistake.

### Step 4 — prove it works

Bump to `0.1.1` (or whatever the next real change warrants) and release it the
normal way. If it publishes with no token anywhere and the npmjs page shows a
**Provenance** panel, the bootstrap is complete and this section never applies
again.

---

## Cutting a release

### Step 0 — dry run first

The dry-run path runs **everything**: every gate, the tarball-contents check,
and `npm publish --dry-run`. It does not authenticate at all, so it works today
— before the bootstrap publish, and before any trusted publisher exists.

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
npm version 0.1.0 --no-git-tag-version
```

`--no-git-tag-version` on purpose: the version bump goes through a PR like any
other change, and the tag comes afterwards, off the merged commit. A tag on an
unmerged commit is how you end up publishing a tree `main` does not have.

### Step 2 — merge it

Open the PR, let CI go green, merge to `main`. Nothing publishes yet.

### Step 3 — tag and push

From the merged commit on `main`:

```bash
git checkout main && git pull
git tag -a v0.1.0 -m 'agent-base 0.1.0'
git push origin v0.1.0
```

The tag **must** be `v` + the exact `package.json` version. The workflow
compares them and refuses a mismatch — that is the classic release footgun
(tag `v0.2.0` pushed while `package.json` still says `0.1.0`), and npm would
otherwise cheerfully publish something the tag does not name.

Pushing the tag is what triggers the publish. There is no other trigger for a
real publish: a manual run with `dry_run: false` from a branch is rejected,
because it would publish an untagged tree.

### Subsequent releases: what the workflow does

Once the bootstrap is done, that is the whole procedure — bump, commit, tag,
push. **No token is created, rotated, or entered anywhere**, and nothing else
is manual.

The workflow, in one job, in this order:

1. **Toolchain** — `actions/setup-node` with
   `registry-url: https://registry.npmjs.org` and `package-manager-cache: false`
   (npm's own guidance: never cache in a release build), then an explicit
   `npm install -g npm@latest`.
2. **Preflight** — asserts npm >= 11.5.1 and Node >= 22.14.0; refuses
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

- The **bootstrap publish has no provenance**, because it comes from a laptop
  rather than CI. Only releases from `0.1.1` onward carry one.
- The **dry-run path does not authenticate**, so it cannot exercise the OIDC
  exchange or the attestation. Both are first exercised by the first real
  workflow publish.

### When a release fails to authenticate

Symptoms are an npm authentication error at the publish step. In order of
likelihood:

- **The trusted publisher is not configured yet** — see the bootstrap section.
- **Workflow filename mismatch** — the npmjs setting must read `publish.yml`,
  the filename alone with its extension, not a path.
- **`id-token: write` was removed or narrowed**, at the job, the repo, or the
  org. The preflight catches this one before the gates run.
- **npm too old** — also caught in preflight, with the version printed.

---

## Verifying a published release

```bash
# 1. the registry has it, with the right files and no auth involved
npm view @swampratnz/agent-base@0.1.0

# 2. a clean consumer install — no .npmrc, no token, no login
mkdir /tmp/verify && cd /tmp/verify && npm init -y >/dev/null
npm install @swampratnz/agent-base@0.1.0

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

### The canary

[`canary-community-agent.yml`](../.github/workflows/canary-community-agent.yml)
builds `community-agent` against **this repo's HEAD** by `npm pack`ing it and
installing the local tarball. That mechanism is unchanged by publishing and
must stay: it is what closes the window in which HEAD here is silently
incompatible with the only consumer, and it works on commits that were never
published.

It is gated behind a repository **variable**, and stays off until the consumer
actually depends on the package:

- **Settings → Secrets and variables → Actions → Variables**
- `AGENT_BASE_CANARY_ENABLED` = `true`

Flip it in the same change that makes `community-agent` declare
`"@swampratnz/agent-base"` as a dependency. Until then the job skips, and a
manual run with `force: true` is how you try it out. The workflow's header
lists exactly what the consumer-side follow-up PR has to do.

Once a version is published, testing the **published** artifact as well as HEAD
becomes possible — a second job, or an input naming a version instead of the
local tarball. That is an optional extra, not a replacement: the local-tarball
path is the one that catches a break before it ships.
