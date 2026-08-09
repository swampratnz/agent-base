# New-agent repo template

Copy this directory into an empty repository to start an agent built on
[`@swampratnz/agent-base`](https://github.com/swampratnz/agent-base).

**This is a starting point, not a working app.** It ships the conventions, the
gate wiring and the empty ratchet-state files that are tedious and
error-prone to recreate — and nothing else.

A repo scaffolded from here **passes its own gate** on day one: it typechecks,
lints, migrates, tests and builds. What it does not do is serve a turn.
`createAgent` requires nine registrations before it will hand back an agent,
and this manifest supplies one (`promptSections`), so `npm run dev` — once
`.env` is filled in — names the other eight and stops:

```
Error: createAgent: 8 problem(s) with this composition — the agent cannot serve a turn:
  - commands (no module supplied `commands`)
  - default bad words (no module supplied `defaultBadWords`)
  …
```

That is the intended first experience. The list is the to-do list for standing
the agent up, and it is better delivered by the runtime than by a README.

## Using it

```bash
cp -r template/. /path/to/my-agent/
cd /path/to/my-agent
git init && npm install
# then, in order:
```

1. **Rename.** `package.json` `name`/`description`; `AGENT_NAME` in
   `src/module/index.ts`; the database name in `.env.example` and
   `.github/workflows/ci.yml`; every `my-agent` in this file and in
   `CLAUDE.md`.
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
6. **Fill in the required registrations**, in `src/module/index.ts`, until
   `npm run dev` stops complaining. Each one is a section in the base repo's
   `docs/MODULE-API.md`; the notice pack is the biggest, because it must cover
   every id in `BASE_NOTICE_IDS`.

## The gates you have inherited

```
npm run typecheck && npm run lint && npm run format:check \
  && npm run migrate && npm test && npm run build \
  && npm run context:check && npm run test:security
```

`npm run migrate` applies the base schema fragments and then whatever
`AgentModule.migrations` declares, in one query. It needs `DATABASE_URL` and
nothing else, so it runs before the app has a full env — CI stands up
pgvector and runs it before the tests, and so should you.

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

One limit worth knowing before you plan around it: there is **no
`configSchema` on the manifest**, so a new env var is a change to the base and
a version bump rather than something you add here. (Parse your own env with zod
in `init()` as the interim.) Outward credentials of your own DO have a seam:
register each as a getter on the manifest's `runtimeSecrets` field and the
base's outbound redaction backstop covers it on every send path.
