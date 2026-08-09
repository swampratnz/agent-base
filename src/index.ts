/**
 * @swampratnz/agent-base — the package's public barrel.
 *
 * The runtime is here: the router spine, the turn engine, the adapters,
 * storage and the scheduler all live under `src/` and ship compiled in
 * `dist/`. This file is a convenience surface over it — `createAgent`, the
 * notice catalogue, the migration runner, the schema manifest, and the types a
 * module manifest is written in terms of. Anything else is imported by its own
 * path (`@swampratnz/agent-base/router.js`); the exports map wildcards every
 * compiled module, so the barrel is deliberately NOT the whole API.
 *
 * **Every type re-exported here is a live one, from the file that runs it.**
 * That is a rule, not an accident. Until 0.1.1 this barrel re-exported the v0
 * contract types in `src/module-api/` — sketches of the intended final shape of
 * each seam, written before the extraction — alongside the real ones, which
 * meant the package exported two different `AgentModule` types (issue #10) and
 * a `ToolDef` the tool server would reject. A type is a stronger claim than a
 * document: nobody builds against a paragraph, but everybody builds against an
 * exported interface. So a seam whose runtime does not exist yet is described
 * in docs/MODULE-API.md — under `planned`, with where the behaviour lives today
 * — and exports nothing from here.
 *
 * Deep-import paths are unaffected either way; a module that already imports
 * `@swampratnz/agent-base/agent/tools/types.js` was always getting the live
 * type and still is.
 */

// --- The composition entry point --------------------------------------------
//
// `AgentModule` is `createAgent`'s, because it is the one `createAgent` takes.
// `AgentModuleManifest` remains as an alias: it is the name the first consumer
// imports, and it reads better at the one site that names the type.
export {
  createAgent,
  planComposition,
  assertRegistrationsComplete,
  type Agent,
  type AgentModule,
  type AgentModule as AgentModuleManifest,
  type CreateAgentOptions,
} from './createAgent.js';

// --- Identity, callers, tiers ------------------------------------------------
export type { Platform, Tier } from './platforms/types.js';
export type { CallerContext } from './auth/rbac.js';

// --- Tools -------------------------------------------------------------------
//
// `ToolDef` is the tool-server's own shape (a `ZodRawShape`, `readOnlyHint`,
// `requiresCapability`), not the v0 sketch's. `ToolServerParts<Ctx>` is the
// registration a module hands in; `Ctx` is the module's own per-turn tool
// context, which the base never looks inside.
export { defineTool, type ToolContext, type ToolDef, type ToolResult } from './agent/tools/types.js';
export type { ToolServerParts } from './agent/toolServer.js';
export type { ToolTierRegistration } from './auth/rbac.js';
export type { FlaggedToolPredicate } from './agent/featureFlags.js';

// --- Router seams ------------------------------------------------------------
//
// Intercepts act through the router (`'continue' | 'handled'`) rather than
// returning reply text, and the spine they append to is frozen.
export type {
  PreTurnContext,
  PreTurnIntercept,
  PostTurnContext,
  PostTurnHandler,
} from './routerIntercepts.js';
export type { TurnStateBag, TurnStateFinalizer } from './agent/turnState.js';
export type { RegisteredCommand } from './commands/registry.js';

// --- Storage -----------------------------------------------------------------
export { migrate, type ModuleMigrationFragment } from './storage/migrate.js';
export { SCHEMA_FRAGMENTS, loadSchemaSql } from './storage/schema/manifest.js';
export type { Queryable } from './storage/repository/shared.js';
export type { LifecycleIdentity, PurgeContributor } from './storage/lifecycle.js';
export type { ProvenanceTrust } from './storage/provenance.js';

// --- Prompt, persona, skills -------------------------------------------------
//
// The prompt slot set is CLOSED (`ModulePromptSections`) and stays that way: an
// open set would let registration introduce prompt text at an unreviewed
// position. The style/language slot bodies are open maps, so nothing is lost.
export type { ModulePromptSections } from './agent/promptSpine.js';
export type { Persona } from './agent/personaRegistry.js';
export type { SkillsManifest } from './agent/skillsManifest.js';

// --- Strings -----------------------------------------------------------------
export {
  BASE_NOTICE_IDS,
  notice,
  isRegisteredLanguage,
  isRegisteredStyle,
  registerNoticePack,
  selectNoticeVariant,
  type NoticeAxes,
  type NoticeEntry,
  type NoticeIdMap,
  type NoticeSelection,
  type NoticeValue,
} from './strings/catalogue.js';

// --- Platforms ---------------------------------------------------------------
export type { AdapterFactory } from './platforms/registry.js';
export type { AdapterPolicyText, AdapterTextPack, PlatformAdapter } from './platforms/types.js';

// --- Secrets -----------------------------------------------------------------
//
// The type the `AgentModule.runtimeSecrets` manifest field is written in terms
// of. The registration function stays a deep import
// (`@swampratnz/agent-base/agent/secrets.js`) — a module registers through the
// manifest, same as provenance.
export type { RuntimeSecretGetter } from './agent/secrets.js';

// --- Alerts ------------------------------------------------------------------
export type { AlertPriority } from './pendingAlertQueue.js';

// --- Jobs --------------------------------------------------------------------
//
// `JobSpec` is the live `{ enabled(cfg), start(adapters) }` shape. There is no
// `jobs` field on the manifest yet — a deployment composes its own job list and
// hands it to the scheduler — so this is exported to be written against, not
// registered. See docs/MODULE-API.md § Jobs.
export type { JobSpec } from './jobs/types.js';
