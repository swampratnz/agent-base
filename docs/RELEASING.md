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
Only the _publishing_ side holds a secret, and that side is one GitHub Actions
workflow.

The mechanism is [`.github/workflows/publish.yml`](../.github/workflows/publish.yml),
whose header comment is the authority on what it actually does; this page is
the procedure around it.

---

## Prerequisites (one-time, owner only)

None of these can be done by CI or by an agent, and the workflow refuses to
publish until they are true. Do them in order.

### 1. Licence — done

The package is **MIT**: `package.json` carries `"license": "MIT"` and the
repository root has the matching `LICENSE` file, which `npm pack` includes
automatically (it does not need to be listed in `files`).

Nothing to do here unless the terms change. If they ever do, both must move
together — the publish preflight fails when `license` is unset or
`UNLICENSED`, and separately when no `LICENSE` file exists to ship alongside
the declared identifier, on the dry-run path as well as the real one.

### 2. An npm account that owns the `@swampratnz` scope

`@swampratnz/agent-base` is **not on the registry** — a `GET` of
`https://registry.npmjs.org/@swampratnz%2Fagent-base` returns 404, so the name
is free as of this writing.

What could **not** be verified from here (this repo's automation holds no npm
credentials and must not authenticate): **whether the `@swampratnz` scope
exists at all**, and if it does, who owns it. Check before the first release:

- if `swampratnz` is a **user account**, the scope `@swampratnz` is that user's
  personal scope and already exists — publishing a scoped package under it
  works once you are logged in as that user;
- if you want it to be an **organisation** scope instead, create the org at
  <https://www.npmjs.com/org/create> _before_ the first publish. Converting a
  user scope to an org scope afterwards is possible but is extra work you would
  rather not do under release pressure.

Either way, the very first publish is the one that claims the name.

### 3. `NPM_TOKEN` as a repository secret

Create an **Automation** token (classic) or a **Granular Access** token on the
npm account that owns the scope:

- npmjs.com → your avatar → **Access Tokens** → **Generate New Token**
- Classic → **Automation**. Automation tokens are the ones that work in CI when
  the account has 2FA enabled for publishing; a Publish/"read and write" token
  will prompt for an OTP and fail the job.
- Granular Access is the tighter option: scope it to
  `@swampratnz/agent-base` (or the `@swampratnz` scope), permission
  **Read and write**, and give it an expiry you will actually remember to
  rotate. Note that a granular token cannot publish a package that does not
  exist yet unless it is scoped to the whole scope — so for the **first**
  release, scope it to `@swampratnz`, not to the package name.

Then add it to this repository:

- **Settings → Secrets and variables → Actions → New repository secret**
- Name: `NPM_TOKEN` — the workflow reads it as `NODE_AUTH_TOKEN` at the publish
  step and nowhere else.

The workflow checks the secret is present in preflight and fails with that
sentence, rather than letting you find out as an npm 401 twenty minutes later.

---

## Cutting a release

### Step 0 — dry run first

The dry-run path runs **everything**: every gate, the tarball-contents check,
and `npm publish --dry-run`. It needs no `NPM_TOKEN`, so you can rehearse the
whole release before the secret exists.

**Actions → Publish to npm → Run workflow**, leave `dry_run` at its default
(`true`). Read the job summary: it lists the tarball's top-level entries and
the SQL-fragment count.

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

### What the workflow then does

In one job, in this order:

1. **Preflight** — resolves dry-run vs real; refuses `private: true`; refuses a
   missing licence; checks the tag shape and that it matches `package.json`;
   checks `NPM_TOKEN` exists (real publishes only). All of this before any long
   step, so a mistake costs seconds.
2. **The full gate** — `typecheck`, `lint`, `format:check`, `context:check`,
   `migrate`, `test` (against the same `pgvector/pgvector:pg16` service
   container CI uses), `test:security`, `build`. A tag can point at any commit,
   including one that never went through a PR, so the gate runs here regardless
   of what CI said on `main`.
3. **Pack and verify** — packs the tarball and asserts it actually contains
   `dist/index.js`, `dist/index.d.ts`, `dist/storage/migrate.js`, both gate
   scripts, and **every** `storage/schema/*.sql` fragment. `files` in
   `package.json` is an allowlist, so its failure mode is silent omission; a
   package that installs but cannot migrate is broken in a way no unit test
   sees.
4. **Publish** — `npm publish --access public --provenance`.

### Provenance

`--provenance` is on. npm records a signed build attestation naming this
repository, workflow and commit; consumers verify it with
`npm audit signatures`, and npmjs.com shows a "Provenance" panel on the package
page.

It works here because **swampratnz/agent-base is a public repository** —
confirmed against the GitHub API when the workflow was written — which is
provenance's hard requirement, along with `id-token: write` (granted at the job
level only) and publishing from a supported CI.

If the repository is ever made **private**, provenance generation fails the
publish. Remove both the `--provenance` flag and the `id-token: write`
permission in the same change, and restore them if it goes public again.

One honest caveat: the **dry-run path does not pass `--provenance`**, because
an attestation for a tarball that is then discarded proves nothing. So the flag
itself is first exercised by the first real publish.

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
