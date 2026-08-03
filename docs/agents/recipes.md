# Change recipes

The shape of the changes this repo actually gets, so a cold session does not
have to infer each one from the tree. Each recipe lists the files a change of
that kind normally touches and **which gate fails if you miss one** — the gate
is the part that turns a forgotten file into a red PR an hour later.

These are starting points, not permissions. Read
[`../ROADMAP.md`](../ROADMAP.md) for what is in scope at this phase.

---

## Every change, without exception

Run the full gate before opening or updating a PR — CI runs the identical set,
so a red PR only makes rework:

```
npm run typecheck && npm run lint && npm run format:check \
  && npm test && npm run build \
  && npm run context:check && npm run test:security
```

`npm run typecheck` also typechecks the **allowlisted** test files
(`tsconfig.tests.json`, an incremental ratchet). If it fails on a test file, fix
the test — do **not** remove its entry to go green. If you make another test
file type-clean, add it to the list; that is the intended unit of progress.

Then:

- **[`../SECURITY.md`](../SECURITY.md)** — if the change adds, removes or moves
  anything on the security spine, or introduces a new input, egress or trust
  boundary.
- **[`module-map.md`](module-map.md)** — if you added, removed or renamed a
  `src/` module. `npm run context:check` fails otherwise; `npm run context:fix`
  does the mechanical part.

---

## Changing a module-API type (`src/module-api/**`)

The most common change here today. What it touches:

| File | Why |
|---|---|
| `src/module-api/<area>.ts` | the type itself |
| `src/index.ts` | the re-export, if the type is new |
| `tests/moduleApi.test.ts` | the contract test builds a plausible module; if the change breaks a real consumer, this stops compiling |
| `docs/MODULE-API.md` | **only if the change reflects real code.** See below |

**The rule that makes this repo useful:** `community-agent` is authoritative
while its refactor is underway. If a seam lands there with a different shape
than the contract guessed, the contract changes to match — not the other way
round. `docs/MODULE-API.md` documents what exists *there*, with a
[contract-vs-code table](../MODULE-API.md#contract-vs-code) at the end. When
you reconcile a difference, delete its row; when you find a new one, add it.
Never describe an unimplemented extension point as though it were real —
mark it `planned` and say where the behaviour lives today.

Gate that catches a miss: `npm run typecheck` (both projects) and `npm test`.

---

## Adding or changing a `SECURITY:` test

| File | Why |
|---|---|
| the test file | the assertion |
| `tests/security-floor.json` | the per-file count, **in the same diff** |

Run `npm run test:security:fix` rather than hand-counting. It only ever raises
counts; removing a security test needs `--allow-lower` *and* an explanation in
the PR, and on a PR the CI baseline guard additionally refuses a lowering
unless the `allow-security-floor-lower` label is applied. That friction is the
feature.

Gate: `npm run test:security`.

---

## Touching a gate script (`scripts/**`)

| File | Why |
|---|---|
| `scripts/<gate>.mjs` | the change |
| `tests/contextPack.test.ts` / `tests/securityFloorGate.test.ts` | every failure mode is driven against fixture trees via `--root`; add a case for the new behaviour |
| `docs/agents/README.md`, `docs/STANDARDS.md` | if the invocation or the convention changed |

Two properties must survive any edit, because they are the whole point:

- the security floor is an **exact** match and its fixer can only raise counts;
- the context fixer **cannot** make its own gate green — it writes a stub that
  keeps the check red until a human writes the description.

A gate script change is a governance-path change: it needs a human merge.

---

## Adding a workflow, or editing CI

| File | Why |
|---|---|
| `.github/workflows/*.yml` | the change |
| `docs/SECURITY.md` §3 | if it changes who can push what, or what "green" means |

Keep `ci.yml` running the same gate set as the local one above; a check that
exists only in CI, or only locally, is a check that will drift. Pin actions by
SHA, keep `permissions: contents: read` unless a job genuinely needs more, and
keep `persist-credentials: false` — `npm test` runs PR code.

`.github/workflows/` is excluded from Prettier: the automation that maintains
this repo pushes with a token that lacks the workflow scope, so it can never
fix a formatting failure there.

---

## Anything under `template/`

`template/` is copied **out** of this repo to start a new agent. It is
deliberately outside the lint and Prettier scopes and outside both tsconfigs:
its `main.ts` imports a runtime that does not exist yet, and formatting it here
would impose this repo's choices on someone else's future repo.

So the gates will **not** catch a mistake in there. Read
[`../../template/README.md`](../../template/README.md) and keep it honest by
hand: it must stay a small, truthful starting point, never a fake working app.

---

## Bringing code across in the extraction pass

Not yet started; see [`../ROADMAP.md`](../ROADMAP.md). When it does, the recipe
per lifted subsystem is:

1. move the code and **its tests** together, verbatim where possible;
2. add each moved test file to `tsconfig.tests.json` if it is type-clean, and
   its `SECURITY:` counts to `tests/security-floor.json`;
3. add the new `src/` paths to [`module-map.md`](module-map.md) in the same
   diff — the gate will not let you defer it;
4. reconcile [`../MODULE-API.md`](../MODULE-API.md)'s contract-vs-code table
   for anything the move settles;
5. once `community-agent` consumes the package, turn the canary on
   (`AGENT_BASE_CANARY_ENABLED`) so a base change that breaks the consumer is
   caught here rather than after a publish.
