/**
 * @swampratnz/agent-base — module API contract (v0).
 *
 * The runtime (router spine, turn engine, adapters, storage, scheduler) lands
 * here via extraction from swampratnz/community-agent once its Phase 1
 * strangler refactor is complete; see docs/ROADMAP.md. Until then this
 * package publishes the base↔module CONTRACT so refactor PRs over there and
 * new agents can code against one set of types.
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
