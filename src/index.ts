/**
 * @swampratnz/agent-base — the package's public barrel.
 *
 * The runtime is here: the router spine, the turn engine, the adapters,
 * storage and the scheduler all live under `src/` and ship compiled in
 * `dist/`. This file is a ~15-symbol convenience surface over it —
 * `createAgent`, the notice catalogue, the migration runner, the schema
 * manifest, and the module-API types. Anything else is imported by its own
 * path (`@swampratnz/agent-base/router.js`); the exports map wildcards every
 * compiled module, so the barrel is deliberately NOT the whole API.
 *
 * Two `AgentModule` types are exported and they are not the same shape. The
 * one re-exported below as `AgentModuleManifest` is `createAgent`'s, and it is
 * what actually runs. `./module-api/module.js`'s is the published v0 CONTRACT,
 * kept for the extension points whose runtime is not reified as registration
 * yet (adapters, jobs, ingest sources) — see docs/MODULE-API.md's
 * contract-vs-code table, and issue #10.
 */

export type {
  AlertPriority,
  CallerContext,
  NotifyRequest,
  Platform,
  Tier,
  TurnStateBag,
} from './module-api/types.js';
export type { ToolContext, ToolDef } from './module-api/tools.js';
export type {
  CommandDef,
  IncomingMessageView,
  InterceptStage,
  JobSpec,
  PostTurnHandler,
  PreTurnIntercept,
} from './module-api/runtime.js';
export type {
  MigrationFragment,
  ProvenanceTrust,
  PurgeContributor,
  Queryable,
  StorageLifecycleHooks,
} from './module-api/storage.js';
export type { Persona, PromptSections, StringsPack } from './module-api/presentation.js';
export type { AdapterFactory, AdapterTextPack, InboundContentPolicy } from './module-api/platform.js';
export type {
  DigestSignal,
  IngestSource,
  QueueProvider,
  RefreshTopic,
  SkillsManifest,
} from './module-api/content.js';
export type { AgentModule } from './module-api/module.js';

// --- The runtime, lifted from community-agent's src/base/ -------------------
//
// The module-API types above stay as the published v0 CONTRACT for the
// extension points whose runtime has not been lifted yet. Everything below is
// live code. `createAgent` is the composition entry point; where its
// `AgentModule` and `module-api/module.ts`'s disagree, createAgent's is what
// actually runs.
export {
  createAgent,
  planComposition,
  assertRegistrationsComplete,
  type Agent,
  type AgentModule as AgentModuleManifest,
  type CreateAgentOptions,
} from './createAgent.js';
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
export { migrate, type ModuleMigrationFragment } from './storage/migrate.js';
export { SCHEMA_FRAGMENTS, loadSchemaSql } from './storage/schema/manifest.js';
