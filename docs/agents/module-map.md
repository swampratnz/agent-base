# Module map

One line per module, so a cold session can find the right file without
grepping the whole tree. Read [`README.md`](README.md) first for how to use
this and [`recipes.md`](recipes.md) for the shape of a typical change.

**This file is gated.** `npm run context:check` (part of CI's lint job) fails
if a `src/` subsystem or top-level module has no entry, if an entry names a
path that no longer exists, or if entries are unsorted, duplicated, or left as
stubs. `npm run context:fix` adds/drops/sorts entries mechanically — it cannot
write the description, which is the part that matters.

Two things this map deliberately does **not** try to be:

- **A substitute for reading the code.** It tells you which file to open, not
  what the code says. Never assert behaviour from a one-liner here.
- **Complete.** Nested files inside a subsystem are called out only where the
  subsystem is big enough that "look in `src/agent/`" is not an answer.

What is **not** here: the content and the composition. Tools, prose, personas,
notice text, the job list, the adapter factory list and the manifest that ties
them together belong to the consuming agent, not to this tree. If you are
looking for one of those, you are in the wrong repo —
[`../MODULE-API.md`](../MODULE-API.md) says which side of the line each seam
falls on.

The security spine — the paths where a mistake is a security bug, not a bug —
is marked **🔒**.

<!-- module-map:begin -->

- `src/ackClassifier.ts` — Deterministic "is this just 'thanks'?" classifier; lets the router skip a whole agent turn (and its cost) on a pure acknowledgement.
- `src/agent/` — 🔒 The Claude Agent SDK integration: system prompt spine and slot assembler, the tool-hosting kernel, the confirm flow, outbound filtering, the WebSearch guard. Most security-relevant subsystem — see the per-file entries below.
- `src/agent/core.ts` — 🔒 Builds the per-turn `query()` options (model, tools, plugins/skills, session tail) and runs the agent turn. Tool surface is derived from the caller's tier here.
- `src/agent/featureFlags.ts` — Base feature-flag predicate slot: core.ts's subtractive per-turn filter reads `flaggedToolPredicates()` from here, registered by a module's tool registry (fail-loud before registration).
- `src/agent/outbound.ts` — 🔒 The outbound reply filter (secret redaction + behaviour policy) applied to every message the bot sends. Deterministic, and deliberately not something the model can talk its way past.
- `src/agent/pendingActions.ts` — 🔒 The confirm-before-destructive flow: destructive tools register a pending action for the router to execute after an explicit confirmation, rather than firing directly.
- `src/agent/personaRegistry.ts` — The base persona registry mechanism: append-only, id-unique registration with a single immutable default; `getPersona`/`selectPersona` resolve over whatever roster the community file registered. Voice only, never authority.
- `src/agent/promptSpine.ts` — 🔒 The system prompt's base-owned security spine (injection-defence/RBAC clauses at hard-coded positions) plus the closed `ModulePromptSections` slot registration; no registration can reorder, rename, or precede a spine clause.
- `src/agent/rateReservers.ts` — The media-input reservation caps (per-sender daily image-input and text-input reservers, and the hourly voice-transcription reserver) the platform adapters check before any media download.
- `src/agent/secrets.ts` — 🔒 `runtimeSecrets()`: the exact-value secret list the outbound filter redacts as a backstop against unknown egress paths. Base credentials are hand-written here (add every new one in the same diff); modules contribute theirs as getters via `AgentModule.runtimeSecrets` / `registerRuntimeSecret()`.
- `src/agent/skillsManifest.ts` — 🔒 Skills manifest registration (`{skillsDir, enabledSkills}`) consumed by core.ts; owns the never-`'all'` allowlist invariant and freezes the registered list so a module can never widen skill activation.
- `src/agent/systemPrompt.ts` — 🔒 The slot assembler for the system prompt: frozen top-level slot order over `promptSpine.ts`'s security spine, registered module sections (the style/language slot bodies are looked up in module-registered maps, so base names no locale), persona voice and role/policy notes. Byte-stability per (role, policy, persona, day) is what the prompt cache depends on.
- `src/agent/toolServer.ts` — 🔒 The base tool-hosting kernel: `buildToolServer` composes the per-turn MCP server from the module-registered parts (`registerToolServerParts` — server name, registry, context factory), failing closed until a module has registered them.
- `src/agent/tools/types.ts` — `ToolDef`/`ToolContext`/`defineTool`: the declarative tool registry's type surface, which a module implements.
- `src/agent/turnState.ts` — Base half of the generic turn-state bag: the module-augmentable `ToolServerTurnState`, the `TurnStateBag` keys base's own router post-turn handlers read, and the finalizer registry `execTurn` runs on the genuine-success path only.
- `src/agent/webSearchGuard.ts` — 🔒 The WebSearch PreToolUse guard: per-conversation hourly volume cap, exact-then-embedding query dedup, and the per-conversation lock keeping check-then-record atomic. Fail-closed by contract — a thrown `embed()` denies the call.
- `src/auth/` — 🔒 Identity and role resolution: tiers come from env plus the users table, never from message content. `tiers.ts` is the dependency-free tier lattice (`atLeast`/`assertAtLeast`); `rbac.ts`'s tier lists are REGISTERED by a module's tool registry and `toolsForRole` fails closed until that registration has run; `memberId.ts` is a thin, fail-closed dispatcher over the platform registry's per-adapter member-id rules.
- `src/backgroundJobCostAlert.ts` — Alerts super admins when background-job spend crosses a configured threshold, so an expensive job cannot run up cost unnoticed.
- `src/backgroundJobHealth.ts` — Pure consecutive-failure debounce tracker for scheduled jobs, so one outage produces one alert rather than an alert per tick.
- `src/budgetCheckFailureNotice.ts` — Pure debounce for the single super-admin DM sent when the daily reply-budget check itself fails (a systemic condition, not a per-user one).
- `src/commands/` — The base command-registry mechanism: the `TEXT_COMMAND_UNMATCHED` sentinel, the handler/binding/`RegisteredCommand` types, the fail-loud `registerCommands`/`registeredCommands` slot both command surfaces read, and the `bindDiscordCommand` late-binding hook.
- `src/commands/registry.ts` — The only file in `src/commands/`: the once-per-process `registerCommands` slot, `registeredCommands()` (which THROWS rather than reporting an empty roster, so an unregistered read can't silently stop every command matching), and `bindDiscordCommand`'s late binding.
- `src/config.ts` — The composition barrel: merges the per-domain slice fragments from `src/config/` into the full env schema, applies the cross-slice refine, parses once (fail-fast on a bad deploy), and exports the `config` singleton plus the pure `loadConfig(env)`.
- `src/config/` — Per-domain zod slice fragments (each var's chain + doc comment lives with its domain) and their slice-local refinements; `env.ts` owns the one dotenv load + blank-normalisation. Adding a setting starts in the right slice here.
- `src/config/boot.ts` — Boot-path config: validates ONLY the db+log slices so `logger.ts`/`storage/db.ts`/`storage/migrate.ts` run with just `DATABASE_URL` — what lets a bare `npm run migrate` work without the app's other required vars.
- `src/context/` — What is left of the context loop once the community sources moved out: the import-free docs-ingest chunk-title leaf shared by ingestion and the knowledge repository.
- `src/context/docTitles.ts` — Import-free leaf for docs-ingest chunk-title helpers (`pageKeyOf`); shared by docsIngest.ts and repository/knowledge.ts so neither imports the other (the old repository ⇄ docsIngest cycle).
- `src/crashHandlers.ts` — Installs handlers for unhandled rejections and uncaught exceptions, so a process death always leaves a logged reason.
- `src/createAgent.ts` — 🔒 The composition entry point: `createAgent({ modules })` plans the composition purely (unique names, one claimant per once-per-process registry, every required registry claimed), then runs init → singleton registrations → additive registrations → the probe gate → migrations → start. An incomplete composition never yields an Agent, so nothing can serve a turn against a half-filled registry. `start()` also starts `src/fleet/`'s reporter, last and after the agent is live, so a supervised deployment needs no wiring of its own.
- `src/fleet/` — Reports this agent's liveness and spend to a bosun supervisor when one is configured, and is completely inert when it is not. Started by `createAgent`'s `start()`, not by the module: forgetting it is silent — the agent runs perfectly and reports a daily spend of zero, so budget caps bind against nothing. Reads per-model cost back out of `interactions` (the map `router.ts` already writes) rather than tapping the turn path, so the router spine and `core.ts` are untouched; the watermark advances only on a report the supervisor accepted.
- `src/gatedNotice.ts` — The member-only notice shown to a gated guest: base resolves, sanitises, caps and joins the admin display names, then interpolates them into the module's `gatedNoticeWithAdmins` template — base owns the filtering, the module owns the sentence.
- `src/health.ts` — The HTTP health server (`/healthz`) and the adapter/DB probes behind it.
- `src/healthState.ts` — Pure health logic (disconnect debounce, payload shape), kept import-free of config and HTTP so it is directly unit-testable.
- `src/index.ts` — The package's public surface: the module-API contract types plus the live runtime exports (`createAgent`, the notice catalogue, the migration runner). If it is not exported here, a consumer must not import it.
- `src/jobs/` — The background-job mechanism: `JobSpec` (open name, declarative gate, self-owned cadence) in `types.ts`, the generic start/stop sweeps in `runner.ts`, and the shared tracked-job wrapper in `trackedJob.ts`.
- `src/jobs/runner.ts` — `startRegisteredJobs(specs, adapters)`/`stopRegisteredJobs(started)` sweep whatever spec list the composition root passes — the runner never imports a job list itself.
- `src/jobs/trackedJob.ts` — `startTrackedJob`: the shared 6h tick + consecutive-failure tracker/alert wrapper most job starters use, plus the queue-on-outage super-admin alert helper the bespoke pollers share.
- `src/logger.ts` — The pino logger plus the hashing helper used to keep identifiers out of logs.
- `src/media/` — Inbound media handling: the Whisper voice-transcription module all three adapters share (decoded on-host, never shipped to a third party), and the text-attachment quarantine that renders an uploaded file as untrusted data.
- `src/moderation/` — Two-stage moderation: a zero-cost wordlist pass over a module-registered default term list, then a model pass, with admins and super admins exempt. The enforcer is injected so the platform side stays swappable.
- `src/mutedRoleAlertNotice.ts` — Pure debounce for the super-admin alert raised when Discord muted-role permission overwrites exhaust their retries.
- `src/notifications.ts` — The shared super-admin DM fan-out every alert producer delegates to (connected-adapters-only, window-reopen queueing, optional queue-on-outage), plus the rolling-hour alert-slot reserver factory behind the router's and moderator's guild-wide alert caps.
- `src/pauseNotice.ts` — Pure debounce for the "the bot is paused" reply, on a longer window than the rate-limit notice because a pause is longer-lived. The text itself is served from the catalogue at the router's call site.
- `src/pendingAlertQueue.ts` — Best-effort queue for super-admin alerts raised while every adapter was disconnected, so an alert during an outage is not simply lost.
- `src/platforms/` — 🔒 The platform abstraction plus the Discord and WhatsApp (Baileys and Cloud API) adapters and the slash-command dispatch mechanism. Adapters own the send path, so outbound filtering and chunking live at their edges.
- `src/platforms/registry.ts` — 🔒 The lightweight platform registry: per-platform descriptors (id + member-id rules, no heavy adapter imports), `KNOWN_PLATFORMS`, and `assertToolAvailabilityConsistent` — the startup/test invariant that every ToolDef platform restriction is derived from declared adapter capabilities, since `Platform` is an open string now.
- `src/platforms/types.ts` — 🔒 The `IncomingMessage` / `PlatformAdapter` contract every adapter normalises into, the open `Platform` string type (registry-validated, closed zod enums at the model boundary), and the `PlatformMemberIdRules` contract the per-platform `memberIdRules.ts` modules implement. Identity fields here are the only trusted source of who is speaking.
- `src/rateLimitNotice.ts` — Pure debounce for the per-user rate-limit notice, so a burst of over-limit messages yields exactly one notice. The text is served from the catalogue at the router's call site.
- `src/replyRetraction.ts` — In-memory, TTL'd, size-capped map from an inbound message to the bot's reply, so a reply can be retracted when the prompt that caused it is deleted.
- `src/retention.ts` — All three age-based retention sweeps (interactions per SECURITY.md's promise, departed roster rows, stale pending access requests) as one parameterised daily job; each purge is gated only on its own days config, so disabling one never suppresses another.
- `src/router.ts` — 🔒 The hot path: every inbound message lands here. The pre-turn sequence now runs as the named intercept chain from `routerIntercepts.ts` (spine steps + registered shortcuts), then the agent call and the post-turn alert/record sequence.
- `src/routerIntercepts.ts` — 🔒 The pre-turn intercept chain contract: the frozen security-spine order (`PRE_TURN_SPINE` — block → role → gate → CONFIRM → … → budget, non-reorderable, pinned by a SECURITY: test) plus the append-only post-spine registry modules register shortcuts and commands into.
- `src/storage/` — 🔒 Postgres + pgvector: the pool, the schema fragments + concatenating migrator, local embeddings, the policy-store mechanism, and the repository that owns every query. Admin-facing reads are conversation-scoped in SQL here.
- `src/storage/lifecycle.ts` — 🔒 The storage lifecycle registries: purge contributors (forget_me/purge_user_data's per-domain deletes + my_data summaries, order-pinned), interactions-invalidated hooks, member-removed and roster-leave hooks. Part of the purge path — the erasure promise is only as complete as what registers here.
- `src/storage/migrate.ts` — The migration runner: concatenates the base schema fragments and then any module-contributed fragments into ONE multi-statement query, so a broken module fragment cannot leave a half-migrated database behind.
- `src/storage/policyStore.ts` — The runtime-policy mechanism: 30s-TTL cached reads/writes over the `policies` table, the base keys (`code_answers`, `paused`) with their accessors, and `registerPolicyKeys` for module keys. Reads/writes of an unregistered key THROW (fail loud), and `resetPolicyCacheForTests` lives here.
- `src/storage/provenance.ts` — 🔒 Provenance→trust registration for `knowledge.created_by_role` (`trustOf`): 'auto' quarantined, 'docs' + the RBAC tier strings trusted, UNKNOWN values fail closed to quarantined. The TS half of the quarantine boundary; the SQL `!= 'auto'` predicates deliberately stay SQL.
- `src/storage/repository.ts` — 🔒 The repository barrel every caller imports: PURE `export *` lines over the per-domain modules in `repository/` — no query bodies live here. Conversation scoping for admin reads is enforced in the queries themselves, not by callers.
- `src/storage/repository/` — 🔒 The per-domain query modules. Add a new query to its domain module here; everything is re-exported through the barrel so import sites never change.
- `src/storage/repository/interactions.ts` — 🔒 The raw interaction archive: recordInteraction, semantic memory search, recap/tail reads, and the platform delete/edit honouring paths (scoped to platform+conversation+message id).
- `src/storage/repository/projects.ts` — 🔒 Project shared memory (issue #927). `visibleProjectIds` is the one place the two access checks live — membership (expanded through linked `persons`) and surface (a bound conversation or a DM) — and every read/write here goes through it in SQL.
- `src/storage/repository/whatsappLidMap.ts` — 🔒 Durable WhatsApp LID -> phone mapping. A LID is a privacy id that looks like a number but matches no one; persisting what the adapter learns from real envelopes lets a LID be resolved rather than refused. PII — erased by `forget_me`/`purge_user_data`. See docs/SECURITY.md §6b.
- `src/storage/schema/` — 🔒 The BASE schema as ordered SQL fragments (00–27 core, 50–53 feature tables, 54 standing preferences, 70 adapter — the numbering is preserved from community-agent so a consumer can adopt these fragments without a migration) concatenated by `manifest.ts` and replayed by `migrate.ts` as ONE atomic query. A module's own tables arrive via `AgentModule.migrations`, appended after every base fragment. Every statement stays `IF NOT EXISTS`; new fragments must be added to the manifest's explicit array (never a glob — order is load-bearing).
- `src/strings/` — The notice-catalogue mechanism: `notice(id, {language, style})` over whatever pack a module registered, owning the language-beats-style precedence, the base id set (`BASE_NOTICE_IDS`) a pack must cover, and the `isRegisteredLanguage`/`isRegisteredStyle` probes base uses instead of naming a locale. Unregistered reads THROW rather than render blank text.
- `src/usageAlert.ts` — Usage-threshold alerting to super admins with a debounce tracker shared by several other alert modules.
- `src/util/` — Shared leaf helpers with no dependencies of their own: configurable-timezone event rendering, the `shouldNotifyAfterWindow` notice debounce, the rate-reservation primitives, and the display-name sanitiser (see entries below).
- `src/util/eventTime.ts` — Timezone-aware, minute-granularity event-time rendering over `DISPLAY_TIMEZONE`/`DISPLAY_LOCALE` (community-agent hardcoded `Pacific/Auckland`/`en-NZ` here as `nzTime.ts`).
- `src/util/rateReservation.ts` — 🔒 The three in-memory rate-cap primitives (sliding window, UTC calendar day, per-key cooldown) behind every tool/adapter reservation cap. Reservations are never refunded on failure, so induced-failure retries can't bypass a cap.
- `src/util/sanitizeName.ts` — 🔒 Neutralises attacker-controlled display names (bracket stripping, whitespace/NEL collapse, hard truncation) before they are interpolated anywhere the model or another member reads them. Every rendered name goes through here.
- `src/voiceLanguageCaveatNotice.ts` — Debounce for the caveat DM sent to a voice-note sender whose standing preference names a REGISTERED language, because the transcription model is English-only and would otherwise fail silently.

<!-- module-map:end -->
