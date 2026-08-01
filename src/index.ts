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
} from "./module-api/types.js";
export type { ToolContext, ToolDef } from "./module-api/tools.js";
export type {
  CommandDef,
  IncomingMessageView,
  InterceptStage,
  JobSpec,
  PostTurnHandler,
  PreTurnIntercept,
} from "./module-api/runtime.js";
export type {
  MigrationFragment,
  ProvenanceTrust,
  PurgeContributor,
  Queryable,
  StorageLifecycleHooks,
} from "./module-api/storage.js";
export type {
  Persona,
  PromptSections,
  StringsPack,
} from "./module-api/presentation.js";
export type {
  AdapterFactory,
  AdapterTextPack,
  InboundContentPolicy,
} from "./module-api/platform.js";
export type {
  DigestSignal,
  IngestSource,
  QueueProvider,
  RefreshTopic,
  SkillsManifest,
} from "./module-api/content.js";
export type { AgentModule } from "./module-api/module.js";
