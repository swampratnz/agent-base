// This agent's module manifest — everything that makes it THIS agent rather
// than a generic one. The base owns ordering and every enforcement point; a
// module registers content and policy into it.
//
// Only the fields you actually use belong here. An empty array is noise; a
// missing field is the honest way to say "not yet".
//
// `AgentModuleManifest` is `createAgent`'s own type, and since 0.2.0 it is an
// ALIAS of the barrel's `AgentModule` — either name works, they are one type.
// (Through 0.1.1 they were two different types: the barrel also exported a v0
// contract sketch under the same name, which `createAgent` would not accept.
// See the base repo's docs/MODULE-API.md, which marks every extension point
// live / partial / planned and exports a type only for the live ones.)
import type { AgentModuleManifest } from '@swampratnz/agent-base';

/** Also the MCP tool namespace: tools are exposed as `mcp__<name>__<tool>`. */
const AGENT_NAME = 'my-agent';

export const myAgentModule: AgentModuleManifest = {
  name: AGENT_NAME,

  // Runs before ANY registration, so it cannot observe or race another
  // module's. Do not read config at module scope — an import-time config read
  // is the chokepoint the base was restructured to remove.
  //
  // init: () => { … },

  // Your tools, plus the MCP server name they hang under and the factory that
  // builds the per-turn context every handler receives. Pin the context type
  // (`AgentModuleManifest<MyToolContext>`) to typecheck the handlers against
  // it.
  //
  // toolServerParts: { name: AGENT_NAME, makeContext, registry: TOOL_REGISTRY },

  // The per-tier tool surface, computed before the model sees anything. Derive
  // these lists from the registry above rather than maintaining them by hand.
  //
  // toolTiers: { member: [], admin: [], superAdmin: [], discordOnly: [] },

  // Your tables, as idempotent SQL fragments. Base fragments run first, yours
  // in declaration order, all in ONE atomic query. Conventions: IF NOT EXISTS
  // everywhere, ADD COLUMN IF NOT EXISTS for evolution, exactly one DROP/ADD
  // pair per named CHECK, and never ALTER a base table's CHECK list.
  //
  // migrations: [{ name: `${AGENT_NAME}-core`, sql: CORE_SQL }],

  // Your runtime policy keys, with the value a never-set key reads as. Reading
  // or writing an unregistered key throws rather than inventing a default.
  //
  // policyKeys: { my_agent_setting: null },

  // Your share of privacy erasure. The base owns the transaction and the
  // linked-identity fan-out; you delete or anonymise your own tables. If you
  // add a table holding user data and do NOT add a contributor here, the
  // agent's erasure promise quietly becomes a lie.
  //
  // purgeContributors: [myPurgeContributor],

  // Your prose. Renders BELOW the base's immutable security spine and can
  // never reorder or displace it. Keep it byte-stable per (role, policy,
  // persona, day) — prompt-cache hit rate depends on it.
  //
  // The slot set is CLOSED and every slot is required: supplying only some of
  // them throws at registration, and an unknown key throws as an unknown key.
  // The last two are MAPS keyed by the caller's standing preference, so the
  // base names no style and no locale — a value with no entry renders no slot.
  promptSections: {
    charter: 'TODO: who this agent is, and who it serves.',
    behaviourGuidelines: 'TODO: your half of the behaviour rules.',
    recallEtiquette: 'TODO: when not to re-run a memory search.',
    conductGuidance: 'TODO: conduct bullets naming your own tools.',
    promptReviewClause: 'TODO: your prompt-review checklist bullet.',
    webSearchAuthority: 'TODO: which sources count as authoritative.',
    dateLine: (now: Date) => `Today is ${now.toISOString().slice(0, 10)}.`,
    responseStyleSections: {},
    languagePreferenceSections: {},
  },
};

// Eight more registrations are REQUIRED before `createAgent` will hand back an
// agent: the notice pack (it must cover every id in `BASE_NOTICE_IDS`), tool
// tiers, tool-server parts, flagged-tool predicates, the skills manifest,
// commands, the default moderation term list, and a persona flagged default.
// Until they are here, `npm run dev` fails at startup with every one of them
// named at once — which is the intended behaviour, not a broken scaffold.
// Filling them in is the work of standing this agent up.
