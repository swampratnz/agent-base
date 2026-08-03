# New-agent repo template

Copy this directory into an empty repository to start an agent built on
[`@swampratnz/agent-base`](https://github.com/swampratnz/agent-base).

**This is a starting point, not a working app.** It ships the conventions, the
gate wiring and the empty ratchet-state files that are tedious and
error-prone to recreate — and nothing else. In particular `src/main.ts` calls
`createAgent`, **which does not exist yet**: the base runtime lands by
extraction (see the base repo's `docs/ROADMAP.md`), and until it does, a repo
scaffolded from here will typecheck its own module manifest and fail to
resolve the runtime import. That is honest and deliberate; a template that
pretended otherwise would be a template you have to un-learn.

## Using it

```bash
cp -r template/. /path/to/my-agent/
cd /path/to/my-agent
git init && npm install
# then, in order:
```

1. **Rename.** `package.json` `name`/`description`; `AGENT_NAME` in
   `src/module/index.ts`; every `my-agent` in this file and in `CLAUDE.md`.
2. **Write `docs/VISION.md`.** What this agent is for and what is out of
   scope. Short. It is the thing you point every future "should we build X?"
   at.
3. **Fill in `docs/SECURITY.md`.** The base invariants are inherited and
   listed there by reference; what you add is *your* assets, *your* tools'
   blast radius, *your* residual risks.
4. **Describe `src/` in `docs/agents/module-map.md`.** `npm run context:check`
   fails until every module has a real one-line description; `npm run
   context:fix` inserts stubs but deliberately cannot write the lines.
5. **Set up CI.** `.github/workflows/ci.yml` runs the gate set standalone
   today; when the base publishes reusable workflows, swap to the call shown in
   its comments.

## The gates you have inherited

```
npm run typecheck && npm run lint && npm run format:check \
  && npm test && npm run build \
  && npm run context:check && npm run test:security
```

Three of these are ratchets, and they are the reason this template exists at
all — they are much easier to start with than to retrofit:

- **`tests/security-floor.json`** starts `{}`. From your first
  `SECURITY:`-prefixed test onward it is an exact per-file count, and lowering
  one needs an explicit flag plus an explanation. Add the entry in the same
  diff as the test (`npm run test:security:fix` does the counting).
- **`tsconfig.tests.json`** starts listing nothing but `src`. Add each test
  file once it is type-clean. Never remove one to go green.
- **`docs/agents/module-map.md`** starts nearly empty and is gated. Describe a
  module in the diff that adds it, or the next cold session gets a map it
  cannot trust.

## What is yours and what is the base's

Everything under `src/module/` is yours: tools, tables, jobs, prose, personas,
string packs, policy keys. Everything the base owns — tool gating, the CONFIRM
flow, outbound filtering, SQL scoping, the router spine, the prompt's security
clauses, the migration runner, the purge transaction — is not overridable, by
design. See the base repo's `docs/MODULE-API.md` for what you can register and
`docs/SECURITY.md` for what you cannot reach around.
