# The module API

What a module registers, and what the base keeps for itself.

This document is written against **real code in this repository**, not against
the extraction plan's aspiration. Where the plan and the code disagree, the
code wins and the difference is called out.

> **Whose `src/` a path means.** Every `src/…` path below is **this
> repository's** — i.e. `@swampratnz/agent-base/<path>.js` from a consumer's
> node_modules. A module's own files live in the consumer repo and are named
> explicitly as such (community-agent's are under its `src/module/`). The two
> trees mirror each other in places — this repo has `src/agent/tools/types.ts`,
> the consumer has `src/module/agent/tools/index.ts` — so the distinction is
> worth reading carefully before opening a file that is not here.

Read [`../src/module-api/`](../src/module-api/) alongside this — those are the
v0 contract types, which describe the same seams in their *intended* final
shape. Where the two differ, the differences are enumerated in
[§ Contract vs. code](#contract-vs-code) at the end. Note that the barrel
exports **two** `AgentModule` types: `createAgent`'s live one (re-exported as
`AgentModuleManifest`) and the v0 contract's. They are not interchangeable and
only the first runs — issue #10.

---

## Status legend

| | Meaning |
|---|---|
| **live** | A real registration API exists, and a module supplies it through the `AgentModule` manifest. The signature shown is the actual one. |
| **partial** | The seam is reified — the base no longer hard-codes the content — but registration is static composition (an array or an object literal in one file), not something a module can hand in. |
| **planned** | No implementation. The plan names the extension point; nothing registers anything yet. Do not build against it. |

The runtime has landed by extraction (see [ROADMAP.md](ROADMAP.md)): `src/`
holds the agent kernel, adapters, storage, router spine, jobs, auth and
config, and `src/createAgent.ts` is the composition entry point. The
`src/module-api/` types remain the published **v0 contract** for the
extension points whose runtime is not yet reified as registration; where they
and the live code disagree, the [contract-vs-code table](#contract-vs-code)
says so and the live code wins.

---

## How registration works

**live.** `src/createAgent.ts`.

```ts
const agent = await createAgent({ modules: [nzCommunityModule] });
await agent.start(() => startAdaptersAndJobs());
```

`createAgent` runs a fixed seven-step order:

1. **plan** — a PURE pass: unique module names, at most one claimant per
   once-per-process registry, every required registry claimed by somebody.
   It reports every problem together and runs before any side effect, so a
   composition that cannot serve a turn is rejected with the process
   untouched. `planComposition(modules)` is exported for use in a test.
2. **init** — each module's `init()`, in declaration order, before anything
   is registered (so an init hook cannot observe or race another module's
   registrations).
3. **singleton registries** — notice pack, tool tiers, tool-server parts,
   flagged-tool predicates, skills manifest, prompt sections, commands,
   default bad words.
4. **additive registries** — personas, turn-state finalizers, policy keys,
   provenance, purge contributors, pre-turn intercepts, post-turn handlers.
5. **the readiness gate** — `assertRegistrationsComplete()` probes the real
   fail-closed accessors: step 1 proved the manifests *say* they fill
   everything, this proves the registries took it.
6. **migrations** — base fragments first, then `AgentModule.migrations`, as
   ONE multi-statement query.
7. **start** — only now may a turn run. `agent.assertStarted()` is the guard.

### The manifest

`AgentModule<Ctx = unknown>` (`src/createAgent.ts`, exported from the barrel as
`AgentModuleManifest`). Every field but `name` is optional, because a
deployment may be composed of several modules that each fill part of the
surface — completeness is required of the composition, not of any one module.

| Field | Registry | Required somewhere in the composition |
|---|---|---|
| `name` | — | yes, and unique |
| `init?` | — | no; runs before any registration |
| `notices?` | notice pack | **yes** |
| `toolTiers?` | tool tiers | **yes** |
| `toolServerParts?` | tool-server parts | **yes** |
| `flaggedToolPredicates?` | flagged-tool predicates | **yes** |
| `skills?` | skills manifest | **yes** |
| `promptSections?` | prompt sections | **yes** |
| `commands?` | command roster | **yes** |
| `defaultBadWords?` | moderation term list | **yes** |
| `personas?` | persona registry | **yes**, and exactly one entry must be `isDefault` |
| `turnStateFinalizers?` · `policyKeys?` · `provenance?` · `purgeContributors?` · `preTurnIntercepts?` · `postTurnHandlers?` · `migrations?` | additive | no |

The eight singleton rows plus `personas` are the nine `assertRegistrationsComplete()`
probes; a composition missing any of them is refused with every gap named at
once. The additive rows are appended, and base owns the iteration order inside
each (see the per-registry sections below).

**`Ctx` is the module's own per-turn tool-context type** — what its
`toolServerParts.makeContext` returns and its handlers receive. The base never
looks inside it. Pin it (`AgentModule<MyToolContext>`) to typecheck every
handler against the real context, or leave it off: bare `AgentModule` still
accepts a concrete parts object, via the deliberate bivariance on
`ToolServerToolDef.handler`. In `0.1.0` the field was typed
`ToolServerParts<never>`, which no module could satisfy and the first consumer
had to cast around; `0.1.1` made the manifest generic, which is the whole
content of that release.

`defaultBadWords` has no section of its own below because there is nothing to
it beyond the registration: it is the whole-word term list stage 1 of
`src/moderation/`'s two-stage check runs against, base ships no list of its
own, and the read fails loud rather than degrading to an empty list — an
unregistered read would be a silent moderation downgrade. Operators extend the
registered list with `MODERATION_BAD_WORDS`; they cannot narrow it.

This replaces community-agent's composition root, which performed
**side-effect imports** of module-owned files in a load-bearing order:

```ts
// community-agent's src/index.ts, before anything that could run a turn
import './module/strings/notices.js';               // registerNoticePack
import './module/storage/policies.js';              // registerPolicyKeys
import './module/agent/communityPromptSections.js'; // registerPromptSections
// …
```

That works for one module in one repo. Its three problems — the order lives in
an import list nothing enforces, a forgotten import surfaces at first use, and
registration-by-import makes import order a correctness problem — are what the
seven steps above address.

Two conventions still hold across every registry, and both are load-bearing:

1. **Register once, then it is frozen.** A second registration throws rather
   than swapping the registered value after boot. A tool inventory, a notice
   pack or a skills allowlist that could be replaced at runtime is an
   escalation surface; "already registered" is the refusal.
2. **Reads fail closed.** Every accessor throws if nothing was registered —
   it never returns an empty list. Silence would mean a forgotten
   composition-root import quietly produced a *narrower* tool surface, a blank
   member-facing notice, or an empty command roster, and nothing would say so.

Ordering is base-owned everywhere it matters: the pre-turn security spine, the
prompt slot order, the purge transaction order, the job start order. Modules
append; they do not sequence.

---

## Tools

**live.** `src/agent/tools/types.ts`, `src/auth/rbac.ts`,
`src/agent/toolServer.ts`, `src/agent/featureFlags.ts`. The tool *inventory*
itself is the module's — community-agent composes it in its own
`src/module/agent/tools/index.ts`.

One declarative definition per tool is the single source for its tier surface,
platform restriction, feature-flag filtering and handler:

```ts
export interface ToolDef<Shape extends ZodRawShape> {
  /** Bare snake_case name; the registry derives `mcp__<server>__<name>`. */
  name: string;
  description: string;
  /** Tier that gets the tool OFFERED (guest keeps the member surface). */
  minTier: 'member' | 'admin' | 'super_admin';
  /** Omit = all platforms. Whenever set, `requiresCapability` must justify it. */
  platforms?: readonly Platform[];
  /** Adapter capability id justifying the platform restriction. */
  requiresCapability?: string;
  /** Evaluated per turn against the live config — never frozen at import. */
  featureFlag?: (cfg: Config) => boolean;
  readOnlyHint: boolean;
  schema: Shape;
  handler: (args: InferShape<Shape>, ctx: ToolContext) => Promise<ToolResult>;
}

export function defineTool<Shape extends ZodRawShape>(def: ToolDef<Shape>): ToolDef<Shape>;
```

The module's composed inventory is what everything else is *derived* from. It
reaches the three registries as three manifest fields, which `createAgent`
registers in step 3:

```ts
toolTiers: { member, admin, superAdmin, discordOnly };   // → auth/rbac.ts
toolServerParts: { name, makeContext, registry };        // → agent/toolServer.ts
flaggedToolPredicates: predicates;                       // → agent/featureFlags.ts
```

(The underlying `registerToolTiers` / `registerToolServerParts` /
`registerFlaggedToolPredicates` are exported and callable directly — a test can
drive one registry in isolation that way — but a module composes by manifest,
not by calling them.)

- `registerToolTiers` replaces the hand-maintained tier arrays. `toolsForRole(role, platform)`
  reads them and additionally drops platform-incompatible tools, so a tool
  nothing can successfully call on a deployment is never offered to the model.
- `registerToolServerParts` gives the base kernel the MCP server **name** (the
  root of every `mcp__<name>__*` id — module-owned, never hard-coded in base),
  the per-turn context factory, and the inventory to attach.
- `registerFlaggedToolPredicates` lets the turn engine subtract flagged tools
  per turn without importing the tool inventory. Predicates are evaluated
  against the *live* config at call time; freezing the boolean at import was
  the original bug.

**What the base owns and a tool cannot reach around:** the per-turn tool
surface is computed from `minTier` before the model sees anything; privileged
handlers re-assert the tier; destructive work goes through `requireConfirm`;
admin reads are bounded by `callerScope()`; every send still passes the
outbound filter.

### The per-turn kernel a handler receives

```ts
export interface ToolContext {
  caller: CallerContext;
  adapter: PlatformAdapter;
  getAdapter?: AdapterLookup;
  turnState?: ToolServerTurnState;
  getLangPref: typeof getLanguagePreference;
  adapterFor: (platform: Platform) => PlatformAdapter | undefined;
  /** Conversations the caller may reach; null = unrestricted (super admin). */
  callerScope: () => Promise<string[] | null>;
  audited: (input: {
    actionKind: string;
    targetUserId?: string;
    conversationId?: string;
    params?: Record<string, unknown>;
    run: () => Promise<string>;
  }) => Promise<{ success: boolean; result: string }>;
  requireConfirm: (
    description: string,
    minTier: 'guest' | 'member' | 'admin' | 'super_admin',
    run: () => Promise<string>,
  ) => ToolResult;
  resolveMemberTarget: (rawUserId: string, platformArg?: Platform) => Promise<{ platform: Platform; userId: string }>;
}
```

`audited` pairs the audit row with the super-admin echo, and `requireConfirm`
queues a pending action rather than executing one. Base owns the *type* above
(`src/agent/tools/types.ts`) and the mechanisms both helpers stand on — the
pending-action store and TTL (`src/agent/pendingActions.ts`), the router's
deterministic confirm intercept with its re-resolved tier, the audit tables,
the notification fan-out. The **factory** that builds one of these per turn is
the module's `toolServerParts.makeContext`; community-agent's lives in a single
`src/module/agent/tools/context.ts` precisely so a domain file there cannot
re-implement either helper wrongly, and a new module should do the same.

### Tool availability is *derived*, not asserted

`assertToolAvailabilityConsistent(defs, factories)` (`src/platforms/registry.ts`)
is the invariant: for every def naming a `requiresCapability`, the platforms it
is offered on must equal exactly the platforms whose adapter factory declares
that capability. A restriction can be neither too wide (offered where no
provider can execute it) nor too narrow (silently dropped from a platform that
does support it). Every def that restricts `platforms` at all must name the
capability that justifies it.

⚠️ **Base exports the check but never calls it.** It takes the tool defs and
the adapter factories, both of which are the deployment's — so the caller has
to be the composition root, and `createAgent` does not do it for you.
community-agent calls it at startup and pins it with a `SECURITY:` test; a new
module must arrange the same, or the derivation is documented but unenforced
for that deployment. (Making it part of `createAgent` needs the factory list to
come through the manifest, which is the `adapters` seam that is still
**planned**.)

---

## Configuration

**partial.** `src/config/*.ts`, `src/config.ts`, `src/config/boot.ts`.

The monolithic env schema is split into per-domain **slices** — plain objects
of zod fields, each with its own doc comments, merged by the barrel:

```ts
export const behaviourSlice = { MEMORY_TOP_K: z.coerce.number()… };
export const behaviourRefinements: EnvRefinement<…>[] = [ … ];
```

Cross-field validation travels with its slice as data (`EnvRefinement`) and is
applied to the merged schema, so a slice-local rule never has to live in the
barrel. The one genuinely cross-slice refinement stays in the barrel with an
explanation.

`src/config/boot.ts` parses **only** the db + log slices, so the storage spine
(`migrate`) runs with nothing but `DATABASE_URL` — this is the precedent for
"each command validates the slice it needs", and it is what let community-agent
retire the dummy-token wrapper its migrate script used to require.

**Not yet:** there is no `configSchema` on the live manifest and no two-phase
"parse env → hand each module its typed slice" init. `config` remains an
import-time singleton, which is the chokepoint the plan lists first.

The cross-repo consequence is the sharp one: a new env var means a new field in
a slice **here**, so it is a base change and a version bump, not something a
consuming module can add. (`AgentModule` in `src/module-api/module.ts` does
declare `configSchema` — that is the v0 contract's aspiration, and nothing
reads it.)

---

## Migrations

**live.** `src/storage/migrate.ts`, `src/storage/schema/*.sql`,
`src/storage/schema/manifest.ts`.

The schema is a set of idempotent SQL fragments concatenated in an explicit,
reviewable order and executed as **one** multi-statement query — the
all-or-nothing replay property is load-bearing, so it is not a directory glob
and the order is not alphabetical by accident:

```ts
export const SCHEMA_FRAGMENTS = ['00-extensions.sql', '01-functions.sql', …] as const;  // 26 base fragments
export async function loadSchemaSql(): Promise<string>;

export interface ModuleMigrationFragment { name: string; sql: string }
export async function migrate(moduleFragments?: readonly ModuleMigrationFragment[]): Promise<void>;
```

A module contributes through `AgentModule.migrations`, and `createAgent`
collects every module's fragments and appends them **after every base
fragment**, in module declaration order, inside that same single query. So a
module's tables can reference base tables, a broken module fragment cannot
leave a half-migrated database behind, and the base numbering (`00–27` core,
`50–54` feature tables, `70` adapter) is preserved from community-agent so an
existing deployment adopts these fragments without a migration.

Conventions a fragment must follow, because the concatenation is replayed over
an already-applied production schema: `IF NOT EXISTS` everywhere,
`ADD COLUMN IF NOT EXISTS` for evolution, exactly one DROP/ADD pair per named
CHECK constraint, and **no ALTERing of a base table's CHECK list** — extensible
enums are registrations, not constraint edits. A test asserts the directory and
the manifest stay in exact sync, so a fragment on disk but missing from the
list fails CI instead of being silently dropped from the migration.

Two build-time gates go with this: `npm run build` copies the fragments into
`dist/` and `scripts/check-dist-schema.mjs` fails the build if `dist/` and the
manifest disagree — a package that installs but cannot migrate is broken in a
way no unit test sees.

**Still base-side:** the BASE list is one static array, so adding a base
fragment is a change to `SCHEMA_FRAGMENTS` here, not a registration. That is
deliberate: base fragment order is load-bearing and reviewable in one place.

---

## Storage lifecycle hooks

**live.** `src/storage/lifecycle.ts`.

The seam that lets each domain own its rows' part of the cross-cutting storage
lifecycles, instead of one privacy module hard-coding every table:

```ts
export interface PurgeContributor {
  /** Stable name (the table it purges) — pinned, with the order, by tests. */
  name: string;
  /** Position in the purge transaction; contributors run sorted ascending. */
  order: number;
  purge(id: LifecycleIdentity, tx: Queryable): Promise<number>;
  summarize?(id: LifecycleIdentity, db: Queryable): Promise<Record<string, number>>;
}

registerPurgeContributor(contributor: PurgeContributor): void;
registerOnInteractionsInvalidated(run: OnInteractionsInvalidated, order = 100): void;
registerOnMemberRemoved(run: OnMemberRemoved, order = 100): void;
registerOnRosterLeave(hook: RosterLeaveHook): void;   // { name, order, run }
```

Three properties matter more than the shapes:

- **Iteration order is explicit, never load order.** Every registration
  carries an `order` and the accessors sort by it, so the statement sequence
  inside the purge transaction is byte-for-byte what the old inline code ran
  regardless of which module happened to load first.
- **The erasure promise is only as complete as the registered set.** A
  partially-registered process would silently purge less than it told the user
  it did. That is why the barrel's `export *` lines (which execute each
  domain module) are the supported way to reach these paths, and why a test
  pins the full contributor roster.
- **Propagation differs by path on purpose.** Purge and member-removal hooks
  propagate — a failure rolls the transaction back. Roster-leave hooks are
  individually `.catch(warn)`-isolated, because a cleanup failure must not turn
  a real departure into a reported no-op.

### Provenance → trust

**live.** `src/storage/provenance.ts`.

```ts
export type ProvenanceTrust = 'quarantined' | 'trusted';
registerProvenance({ id: string, trust: ProvenanceTrust }): void;
trustOf(provenance: string): ProvenanceTrust;   // UNKNOWN ⇒ 'quarantined'
```

`trustOf` **fails closed**: an unregistered provenance value is quarantined.
The predicate this replaced (`created_by_role !== 'auto'`) failed *open* — an
unknown value was treated as trusted. Note that the SQL-side quarantine
predicate deliberately stays as SQL: rewriting it as an IN-list of registered
trusted values would flip it from fail-closed back to enumerate-open.

### Runtime policies

**live.** `src/storage/policyStore.ts`.

```ts
registerPolicyKeys(moduleDefaults: Record<string, unknown>): void;
```

The base owns the cached reader/writer and two keys (`code_answers`,
`paused`); a module registers its own keys with their never-set defaults.
Reading or writing an unregistered key **throws** rather than inventing a
default, so a typo surfaces immediately instead of as a phantom policy that
always reads null. A duplicate key throws too.

---

## Jobs

**partial**, and with a shape that differs from the plan. `src/jobs/types.ts`,
`src/jobs/runner.ts`, `src/jobs/trackedJob.ts`.

```ts
export interface JobSpec {
  /** Open string — a module can define a job the base never heard of. */
  name: string;
  /** Declarative form of the gate `start()` already enforces internally. */
  enabled(cfg: Config): boolean;
  /** Starts the job (or returns null when its own gate is off). */
  start(adapters: readonly PlatformAdapter[]): JobTimer | null;
}

export function startRegisteredJobs(specs: readonly JobSpec[], adapters: readonly PlatformAdapter[]): StartedJob[];
export function stopRegisteredJobs(started: readonly StartedJob[]): void;
```

**Why partial: there is no `jobs` field on the manifest.** Base ships the
*mechanism* — the `JobSpec` contract, the two sweeps, and `startTrackedJob`'s
shared 6h tick with its consecutive-failure tracker and alert — but the job
LIST is the module's own array, and the composition root passes it:
`startRegisteredJobs(JOB_REGISTRY, adapters)`, inside the callback given to
`agent.start()`. `runner.ts` deliberately imports no list of its own.
community-agent's list lives in its `src/module/jobs/registry.ts`.

The plan's `{ intervalMs, runOnce() }` shape is **not** what exists, and the
code explains why: today's jobs are a mix of a shared multi-hour tick with
per-job freshness guards, bespoke fixed intervals, and configurable pollers.
Collapsing those onto one `intervalMs` would misdescribe most of them, so each
job keeps its own cadence mechanism and the list owns only the order. Order is
worth pinning with a test in the consuming repo — nothing is known to depend on
it, but every job fires an immediate first run against the same database, so
reordering is a deliberate change. Add new jobs at the end.

`enabled(cfg)` is declarative only: `startRegisteredJobs` does not consult it
(starters self-gate, byte-for-byte as before the registry existed). It exists
so the gate is inspectable and testable without starting timers.

Note the deliberate tension with the database: job **names** are an open
string, but the subset of names written to a cost-tracking column is a closed
union, because a CHECK constrains it. The same tension resolves the same way
for locale axes below.

---

## Router intercepts and post-turn handlers

**live.** `src/routerIntercepts.ts`.

The pre-turn chain has two regions with different trust rules:

```ts
export const PRE_TURN_SPINE = Object.freeze([
  'block-list', 'role-resolution', 'gated-guest', 'record-inbound',
  'confirm-intercept', 'escalation-confirm', 'addressed-gate', 'pause',
  'rate-limit', 'daily-budget', 'auto-answer-reserve', 'memory-barrier',
  'auto-answer-thread',
] as const);

registerPreTurnIntercept(intercept: { name: string; run(ctx): Promise<'continue' | 'handled'> }): void;
registerPostTurnHandler(handler: { name: string; run(ctx): Promise<void> }): void;
```

- The **spine** is frozen and base-built. There is no registration API that
  can insert, remove or reorder a spine step, and a `SECURITY:` test pins both
  the freeze and the exact order. The order is load-bearing: CONFIRM runs
  before the addressed check so a bare "CONFIRM" works in a group; pause runs
  before rate-limit so a paused user never sees both notices; the budget read
  runs after both so shed messages never pay for one.
- **Registered intercepts append after the last spine step**, so nothing a
  module registers can run before block / role / gate / CONFIRM / pause / rate
  / budget. Reusing a spine step's name is rejected outright rather than
  shadowing it, as is a duplicate name.
- **Post-turn handlers observe, they do not rewrite.** They run after a
  successful turn with the module's keys on `reply.turnState`, and can fire
  side effects (alerts, outbound-meta stamps) but cannot change the reply text,
  the caches, or anything the spine already decided.

### Turn state

**live.** `src/agent/turnState.ts`.

```ts
export interface ToolServerTurnState {}   // empty; modules augment via `declare module`
export interface TurnStateBag {
  knowledgeEntryId?: number;
  unhelpfulAnswerRated?: boolean;
  humanHelpRequested?: boolean;
  knowledgeGapCluster?: CrossedKnowledgeGapCluster;
  staleKnowledgeAlertIds?: number[];
}
export type TurnStateFinalizer = (turnState: ToolServerTurnState) => Partial<TurnStateBag>;
registerTurnStateFinalizer(finalizer: TurnStateFinalizer): void;
```

`ToolServerTurnState` — the scratch a handler writes during the turn — **is**
empty; every key on it is a module's, added by declaration merging, so the turn
engine stays module-agnostic while keys keep concrete types at call sites.

`TurnStateBag` is not empty, and could not be: base ships the post-turn
handlers for admin escalation, knowledge-gap alerting, stale-knowledge alerting
and knowledge-hit correlation, so it has to be able to NAME the five keys they
read. It ships no tool handlers at all, so WRITING them is still entirely a
module's job — every key stays optional and absent-not-zero, and a module with
no rating or knowledge-search tool simply never fires those handlers. Modules
add their own keys by the same declaration merging.

Finalizers run on the **genuine-success path only**, preserving the "never set
on a fallback or error reply" contract of the hardcoded fields they replaced.

---

## Commands

**live.** `src/commands/registry.ts`.

```ts
export interface RegisteredCommand {
  name: string;
  platforms: readonly Platform[];
  whatsapp?: WhatsAppTextCommandHandler;   // the `!name` text path
  discord?: DiscordCommandBinding;         // { build(), handle() } — bound late
}

registerCommands(commands: readonly RegisteredCommand[]): void;
registeredCommands(): readonly RegisteredCommand[];   // throws if never registered
bindDiscordCommand(name: string, binding: DiscordCommandBinding): void;
```

One list, two surfaces: Discord slash registration and the router's text-command
intercept both read whatever was registered, so neither mechanism file imports
the command content. A WhatsApp handler returns the `TEXT_COMMAND_UNMATCHED`
sentinel for "not my command" — distinct from `null`, which means "matched, but
fall through to a normal turn". That distinction is a privacy decision, not a
style one: a group reply has no ephemeral concept, so a bespoke denial would
out an ineligible caller's tier to the whole group.

`bindDiscordCommand` rejects a binding for an unknown name and a double bind.

---

## Prompt sections, personas, skills

### Prompt sections

**live**, and the slot set is **closed**. `src/agent/promptSpine.ts`.

```ts
export interface ModulePromptSections {
  /** Who the agent serves; renders first. */
  charter: string;
  /** The module's half of the behaviour guidelines; renders under the header. */
  behaviourGuidelines: string;
  /** When NOT to re-run a memory search; renders between the two spine chunks. */
  recallEtiquette: string;
  /** Conduct/tool-offer bullets naming the module's own tools; after the privileged-tool clause. */
  conductGuidance: string;
  /** The prompt-review checklist bullet, inlined while the skills flag is off. */
  promptReviewClause: string;
  /** Source-authority half of the web-search role note. */
  webSearchAuthority: string;
  /** The Context block's date line. DAY granularity, or the prompt cache dies. */
  dateLine: (now: Date) => string;
  /** 'response-style' slot bodies, keyed by the caller's standing style value. */
  responseStyleSections: Readonly<Record<string, string>>;
  /** 'language-preference' slot bodies, keyed by the caller's standing language value. */
  languagePreferenceSections: Readonly<Record<string, string>>;
}

registerPromptSections(sections: ModulePromptSections): void;   // → AgentModule.promptSections
```

Nine fields, **all required** — a module supplies every one or registration
throws naming the missing slot, so a half-registered prompt can never boot. An
**unknown** key is rejected *before* the already-registered check, so an
attempt to name a new slot (or impersonate a spine clause) is refused as such
rather than masked as a duplicate.

Two of the nine are **maps, not fields**, and that is the point: a value with
no entry renders no slot at all, so the axis values ('plain', 'mi', …) are the
module's and base names no locale and no style. community-agent's pre-extraction
type had `communityConduct`, `plainLanguageStyle`, `enLanguagePreference` and
`miLanguagePreference` as four fixed string fields; those names do not exist
here and registering under them throws.

The base owns the render order and interleaves the frozen security clauses
(`SECURITY_SPINE_CORE`, `SECURITY_SPINE_PRIVILEGED`, `AUTHORIZATION_NOTE`,
`TONE_CALIBRATION_CLAUSE`) between the registered chunks at fixed positions.
Registration cannot reorder, rename, precede or displace a spine clause.

⚠️ **Byte-stability is load-bearing.** Assembly must produce byte-identical
output per (role, policy, persona, day) or prompt-cache hit rates collapse and
cost roughly doubles. `dateLine` is day-granularity for exactly this reason. A
test pins it; keep that test in the same diff as any assembler change.

### Personas

**live.** `src/agent/personaRegistry.ts`.

```ts
export interface Persona { id: string; name: string; aliases: string[]; voice: string }
registerPersona(persona: Persona, opts?: { isDefault?: boolean }): void;
getPersona(id: string | null | undefined): Persona;
selectPersona(opts: { text?: string }): Persona;
```

Append-only and id-unique: re-registering an id throws (a voice swap is a code
change, not a second registration), and exactly one persona may be flagged
default. **A persona changes how the bot sounds, never what it can do** —
permissions come from the caller's tier and the tool gating. Every persona's
turn is assembled with identical security guidelines and the same role-derived
tool set; only the `voice` block differs. That is what keeps personas from
becoming a "let me talk to the admin bot" escalation surface.

### Skills

**live**, and it is a security-spine file. `src/agent/skillsManifest.ts`.

```ts
export interface SkillsManifest {
  skillsDir: string;              // a repo-bundled, code-reviewed directory
  enabledSkills: readonly string[];  // literal allowlist — never 'all'
}
registerSkillsManifest(candidate: SkillsManifest): void;
```

The invariant it owns is **never `'all'`**: the SDK's wildcard would activate
every skill file present in the directory, so a future skill dropped in would
self-activate without the deliberate second edit the allowlist requires.
Content validation runs before the already-registered check (so a hostile
widening attempt is rejected as such, not masked as a duplicate), the list is
copied and frozen (so no later mutation widens it), and a second registration
throws. A module can only ever narrow what its own bundled directory offers.

---

## Adapters

**partial.** `src/platforms/registry.ts`, `src/platforms/types.ts`, and the
concrete adapters under `src/platforms/discord/` and
`src/platforms/whatsapp/`. The FACTORY list is the deployment's — community-agent
composes it in its own `src/module/platforms/factories.ts` — and so is the text
pack each adapter is constructed with.

`Platform` is an open `string`. The registry has two layers split by import
weight, which is what lets id-validation code dispatch over platforms without
dragging Discord and WhatsApp client libraries into every import graph:

```ts
export interface PlatformDescriptor {
  readonly platform: Platform;
  readonly memberId: PlatformMemberIdRules;   // lightweight; leaf imports only
}

export interface AdapterFactory {
  readonly platform: Platform;
  /** Capability ids this PLATFORM declares, for tool availability. */
  readonly toolCapabilities: ReadonlySet<string>;
  /** Build the adapter, or null when the platform is disabled for this deployment. */
  create(): PlatformAdapter | null;
}
```

`toolCapabilities` is a **union over the platform's selectable providers** on
purpose: availability must be deployment-stable, so a capability only one
provider implements is declared here and feature-checked in the handler at
runtime, rather than making `toolsForRole` vary with provider selection.

**Not yet:** `PLATFORM_DESCRIPTORS` is a static array here, the factory list is
a static array over in the module, there is no `adapters` field on the
manifest, and `create()` takes no argument because adapters still read the
config singleton. Opening the `Platform` type moved no trust decision: roles
still come from env + storage, tool surfaces are still tier-derived, and
model-facing platform arguments remain **closed** zod enums.

### Adapter text packs

**live.** `AdapterTextPack` and `AdapterPolicyText` in
`src/platforms/types.ts`. (`src/module-api/platform.ts` exports a v0 type of
the same name through the barrel — the adapters take the one below.)

```ts
export interface AdapterTextPack {
  /** Join-welcome fallback when no admin-configured welcome_message policy is set. */
  welcomeMessage: string;
  /** Welcome fallback when this platform's access mode is 'open'. */
  welcomeMessageOpen: string;
  /** Fixed shell prefixed to a manual `warn_user` DM; the reason is appended verbatim. */
  warnUserDmPrefix: string;
  /** Per-language variants of the above, keyed by the OPEN language axis. */
  warnUserDmPrefixByLanguage?: Readonly<Record<string, string>>;
  /** REQUIRED — an adapter owns no policy key, so there is no default to fall back to. */
  policyText: AdapterPolicyText;
}

export interface AdapterPolicyText {
  welcomeMessage: () => Promise<string | null>;
  welcomeMessageForLanguage: (language: string) => Promise<string | null>;
  guidelines: () => Promise<string | null>;
}
```

Each adapter takes a pack as a **required** constructor parameter, so no
adapter carries deployment prose of its own and a different module supplies a
different pack without forking the adapter. Everything built from a pack still
leaves through that adapter's `filtered()` send path — **a pack supplies
content, never an egress path**.

Two halves, deliberately: the literals are fixed strings, and `policyText` is
the runtime-configurable half — the stored-policy reads an adapter composes
over them. Base names neither the policy key nor any locale, which is why
`warnUserDmPrefixByLanguage` is an open map rather than the fixed
`warnUserDmPrefixMi` field community-agent had before the lift.

---

## Strings and locale axes

**live.** `src/strings/catalogue.ts`.

```ts
export interface NoticeEntry<T> { base: T; language?: Record<string, T>; style?: Record<string, T> }
export interface NoticeAxes { languages: readonly string[]; styles: readonly string[] }

registerNoticePack(axes: NoticeAxes, entries: Record<string, NoticeEntry<NoticeValue>>): void;
notice<K extends keyof NoticeIdMap>(id: K, selection?: { language?: string; style?: string }): NoticeIdMap[K];
```

Selection precedence, implemented once instead of re-encoded at every call
site:

1. a **registered language** the caller has set claims the turn — that
   variant, or the base text if the entry has no variant for it. The style
   axis is never consulted once a registered language applies;
2. otherwise a **registered style** selects its variant, or the base text;
3. otherwise the base text. Values that mean "default" (`auto`, `en`,
   `standard`) are simply not registered axis values.

Pass the caller's raw preferences; never pre-resolve precedence at a call site.
Every value in a pack is a fixed, human-authored literal — no model call, no
translation, no runtime input — and everything selected still leaves through
the outbound filter, so the catalogue adds no egress path.

`NoticeIdMap` declares the **31 ids base itself serves**, each with a concrete
type — some plain strings, some templates (`codeTruncatedNote: (shown: number)
=> string`) — so `notice()` returns a template as its function type with no
casts at call sites, and an id nobody declared is a **compile** error rather
than only a runtime throw. A module augments the interface via `declare module`
with ids of its own: the base set is a floor, not a ceiling.

`BASE_NOTICE_IDS` is the runtime twin of that floor, and
`registerNoticePack` refuses a pack that misses any of them, naming every gap
at once. It has to be a separate list because types vanish at runtime; a test
pins the two in sync. Registration happens inside `createAgent` before a turn
can run, so a missing id is a boot failure rather than blank text in front of a
member on some path the author never exercised.

The DB-facing preference unions and the model-facing tool input enums stay
**closed**, because a CHECK constrains the stored values and a closed
model-facing enum is a security invariant. Open axis, closed storage: the same
resolution as job names.

---

## Not implemented yet

These are named in the plan's extension-point table and have **no
implementation**. Documented here so nobody builds against them:

| Extension point | Where the behaviour lives today |
|---|---|
| `configSchema` — an env slice per module | `src/config.ts` is an import-time singleton over the slices in `src/config/`. A module adds a file there and a line in the barrel — i.e. an env var is a base change. `AgentModule` has no `configSchema` field |
| `moderationPolicy` — inbound-content hook + post-warn strike policy | the moderator is constructed inside the Discord adapter (`createModerator`); the term list IS registered (`defaultBadWords`), the policy around it is not |
| `digestSignals` / `reviewQueues` / `submissionProviders` | the admin digest builder takes its signals as positional parameters; queue lists live in the module |
| `ingestSources` / `refreshTopics` | index URLs, path strips and topic lists are module *code*, not env, and must stay that way — the researchable surface must not be runtime-controllable |
| `secrets` — `registerRuntimeSecret()` per credential | `src/agent/secrets.ts`'s `runtimeSecrets()` is a hand-written function reading the config singleton, and it lists the BASE credentials only. There is no way for a module to add one, so a module's own outward credential is not covered by the redaction backstop today. Every new base credential must be added there by hand |
| `auditActionKinds` / `trackedCostJobs` | fixed constants (`MODERATION_ACTION_KINDS` in `src/storage/repository/adminStats.ts`, the `BackgroundJob` union beside it) — both closed because a DB CHECK constrains them |
| `featureFlags` (the operator rundown) | a fixed map in the module. Distinct from the *tool-level* flag predicates, which ARE registered |
| `adapters` — a factory list on the manifest | static arrays: `PLATFORM_DESCRIPTORS` here, `ADAPTER_FACTORIES` in the module. This is also why `assertToolAvailabilityConsistent` has to be called by the composition root |
| ~~`createAgent({ modules })`~~ | **live** — `src/createAgent.ts` (see [§ How registration works](#how-registration-works)) |
| ~~`migrations` per module~~ | **live** — `AgentModule.migrations`, appended after every base fragment |

---

## Contract vs. code

Differences between this package's v0 types in `src/module-api/` and the code
they describe. The extraction has landed, so each row is now a reconciliation
decision somebody owes — bring the type to the code, or change the code — and
`src/module-api/` stays published in the meantime because it is the only
description of the seams whose runtime is not reified as registration yet:

| Contract type | Code today | Note |
|---|---|---|
| `AgentModule` (`src/module-api/module.ts`) | `AgentModule<Ctx>` (`src/createAgent.ts`), re-exported as `AgentModuleManifest` | **The one to know.** Both are exported from the barrel and they are not assignable to each other — the v0 `init(ctx)` alone makes it a TS2322. The live one is what `createAgent` takes, and its field set is different: no `configSchema`, `tools`, `jobs`, `adapters`, `strings`, `runtimeSecrets` or `purge`; instead `toolServerParts`, `toolTiers`, `flaggedToolPredicates`, `notices`, `defaultBadWords`, `policyKeys`, `provenance`, `purgeContributors`. Tracked as issue #10. |
| `JobSpec { intervalMs, runOnce() }` | `JobSpec { enabled(cfg), start(adapters) }` | The code is deliberate and documented: today's cadences are heterogeneous and one `intervalMs` would misdescribe most of them. The contract is the aspiration. |
| `ToolDef.capabilityLine`, `ToolDef.rateLimit` | neither field exists | Capability rundown text is still static prose in a tools domain file; rate reservations are separate helpers the handlers call. |
| `ToolDef.schema: z.ZodTypeAny` | `schema: ZodRawShape` | The SDK's `tool()` helper takes a raw shape; the contract assumes a full zod type. |
| `ToolDef.readOnly?` | `readOnlyHint` (required) | Name and optionality both differ. |
| `ToolDef` has no capability field | `requiresCapability` exists and is *enforced* | The code is ahead of the contract here — availability is derived-and-verified, not declared. |
| `ToolContext.requireConfirm(spec)` returning `string` | `requireConfirm(description, minTier, run)` returning `ToolResult` | Positional, and returns the tool result shape. |
| `ToolContext.audited(kind, params, run)` | `audited({ actionKind, targetUserId?, conversationId?, params?, run })` | Object form, with target/conversation fields. |
| `ToolContext.callerScope(): Promise<string[]>` | `Promise<string[] \| null>` | `null` means unrestricted (super admin) — a meaningful third state the contract loses. |
| `ProvenanceTrust = 'quarantined' \| 'trusted' \| 'human-tier'` | `'quarantined' \| 'trusted'` | Human tiers are registered as `trusted` explicitly rather than being a third kind. |
| `PurgeContributor.purge(platform, userId, tx)` | `purge(id: LifecycleIdentity, tx)`, plus required `name` and `order` | The order field is the important omission: iteration order must be explicit, not load order. |
| `TurnStateBag = Map<string, unknown>` | an interface declaring the five keys base's own post-turn handlers read, augmentable by a module for its own | The code keeps concrete per-key types; the contract erases them. Base has to declare the keys it READS — nothing else in the tree writes them, so an empty interface left base's own router uncompilable. |
| `PreTurnIntercept.handle() => string \| null` | `run(ctx) => 'continue' \| 'handled'` | The code's intercepts act through the router rather than returning reply text. |
| `AdapterTextPack` with a `variants` map | `warnUserDmPrefixByLanguage?: Record<string, string>` plus a required `policyText` | Resolved during the lift: the fixed `warnUserDmPrefixMi` field became an open per-language map keyed by the registered axis, so base names no locale. Same idea as the contract's `variants`, one level flatter. The contract has no equivalent of `policyText`, the stored-policy half the adapters require. |
| `AgentModule.name` doubles as the MCP namespace | the MCP server name is registered via `registerToolServerParts({ name })` | Same idea, different carrier. |
| `strings` pack registered per module | exactly ONE notice pack per process, and it must cover every id in `BASE_NOTICE_IDS` | `registerNoticePack` throws on a second call, and now also on an INCOMPLETE first call, naming every missing id — base declares the ids it serves and a pack supplies the text. Multi-module string packs still need a merge step that does not exist; `createAgent` refuses two claimants rather than silently picking one. |
| `promptSections` as an open set | a **closed**, all-required slot set (`ModulePromptSections`) | The code's version is stronger and should win: an open set would let registration introduce prompt text at an unreviewed position. The style/language slot BODIES are open maps keyed by the caller's raw preference, so the closed slot set costs no localisation flexibility. |
