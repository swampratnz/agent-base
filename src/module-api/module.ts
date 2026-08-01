import type { z } from "zod";
import type { ToolDef } from "./tools.js";
import type {
  CommandDef,
  JobSpec,
  PostTurnHandler,
  PreTurnIntercept,
} from "./runtime.js";
import type {
  MigrationFragment,
  PurgeContributor,
  StorageLifecycleHooks,
} from "./storage.js";
import type { Persona, PromptSections, StringsPack } from "./presentation.js";
import type {
  AdapterFactory,
  AdapterTextPack,
  InboundContentPolicy,
} from "./platform.js";
import type {
  DigestSignal,
  IngestSource,
  QueueProvider,
  RefreshTopic,
  SkillsManifest,
} from "./content.js";

/**
 * The manifest a module hands to `createAgent({ modules: [...] })`.
 *
 * Everything is registration: the base owns ordering, the security spine, and
 * every enforcement point (tool gating, CONFIRM flow, outbound filtering, SQL
 * scoping, quarantine rendering). Nothing registered here can bypass or
 * reorder those.
 *
 * Contract status: v0 — refined against the Phase 1 strangler refactor in
 * swampratnz/community-agent, which is authoritative while it is underway.
 */
export interface AgentModule {
  /** Unique module name; also the MCP tool-namespace segment. */
  name: string;

  /** Zod slice parsed by the base env loader; handed back typed at init. */
  configSchema?: z.ZodTypeAny;

  /** Called once after config parse, before anything registered runs. */
  init?(ctx: { config: unknown }): Promise<void> | void;

  tools?: readonly ToolDef[];
  jobs?: readonly JobSpec[];
  intercepts?: readonly PreTurnIntercept[];
  postTurnHandlers?: readonly PostTurnHandler[];
  commands?: readonly CommandDef[];

  migrations?: readonly MigrationFragment[];
  purge?: PurgeContributor;
  storageHooks?: StorageLifecycleHooks;

  promptSections?: PromptSections;
  personas?: readonly Persona[];
  defaultPersonaId?: string;
  strings?: StringsPack;

  adapters?: readonly AdapterFactory[];
  adapterText?: AdapterTextPack;
  inboundPolicy?: InboundContentPolicy;

  ingestSources?: readonly IngestSource[];
  refreshTopics?: readonly RefreshTopic[];
  digestSignals?: readonly DigestSignal[];
  reviewQueues?: readonly QueueProvider[];
  skills?: SkillsManifest;

  /** Exact secret values the outbound filter must redact (DLP backstop). */
  runtimeSecrets?(moduleConfig: unknown): readonly string[];
  /** Audit action kinds this module writes (feeds the audit-view allowlist). */
  auditActionKinds?: readonly string[];
  /** Dotted flag names surfaced in the feature_flags operator rundown. */
  featureFlags?: Readonly<Record<string, (moduleConfig: unknown) => boolean>>;
  /** Job names whose LLM spend the cost-spike alert should track. */
  trackedCostJobs?: readonly string[];
}
