// This agent's module manifest — everything that makes it THIS agent rather
// than a generic one. The base owns ordering and every enforcement point; a
// module registers content and policy into it.
//
// Only the fields you actually use belong here. An empty array is noise; a
// missing field is the honest way to say "not yet".
//
// See the base repo's docs/MODULE-API.md for what each extension point really
// does today — several listed in the plan are not implemented yet, and that
// document marks which.
import { z } from 'zod';
import type { AgentModule } from '@swampratnz/agent-base';

/** Also the MCP tool namespace: tools are exposed as `mcp__<name>__<tool>`. */
const AGENT_NAME = 'my-agent';

export const myAgentModule: AgentModule = {
  name: AGENT_NAME,

  // Your env slice. Parsed by the base loader and handed back typed at init —
  // do NOT read process.env anywhere else, and do not read config at module
  // scope: an import-time config read is the chokepoint the base was
  // restructured to remove.
  configSchema: z.object({
    // MY_AGENT_FEATURE_ENABLED: z.coerce.boolean().default(false),
  }),

  // Tools. One declaration is the single source for the tier surface, platform
  // filtering, feature-flag filtering, confirm gating and the capability
  // rundown — so a tool can never be offered to a tier that cannot call it, or
  // be callable without appearing in the rundown.
  //
  // tools: [exampleTool],

  // Your tables, as idempotent SQL fragments. Base fragments run first, yours
  // in registration order, all in ONE atomic query. Conventions: IF NOT EXISTS
  // everywhere, ADD COLUMN IF NOT EXISTS for evolution, exactly one DROP/ADD
  // pair per named CHECK, and never ALTER a base table's CHECK list.
  //
  // migrations: [{ name: `${AGENT_NAME}-core`, sql: CORE_SQL }],

  // Your scheduled work. The base owns the scheduler: tracked runs, the
  // re-entrancy latch, consecutive-failure alerting, cost recording, and one
  // shutdown sweep.
  //
  // jobs: [myJob],

  // Your prose. Renders BELOW the base's immutable security spine and can
  // never reorder or displace it. Keep it byte-stable per (role, policy,
  // persona, day) — prompt-cache hit rate depends on it.
  promptSections: {
    charter: 'TODO: who this agent is, and who it serves.',
  },

  // Your share of privacy erasure. The base owns the transaction and the
  // linked-identity fan-out; you delete or anonymise your own tables. If you
  // add a table holding user data and do NOT add it here, the agent's erasure
  // promise quietly becomes a lie.
  //
  // purge: myPurgeContributor,

  // Exact credential values the outbound filter must redact. Every outward
  // credential goes here, not just the ones whose one send site already
  // redacts them — this is the backstop for egress paths nobody thought of.
  //
  // runtimeSecrets: (cfg) => [cfg.myApiToken],
};
