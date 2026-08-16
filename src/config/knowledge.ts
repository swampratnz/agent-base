import { z } from 'zod';
import type { EnvRefinement } from './env.js';

/**
 * Knowledge-pipeline slice (config.contextBuilder + config.contextCandidates +
 * config.knowledgeAnswerCandidate + config.knowledgeRefresh +
 * config.docsIngest + config.releaseWatch + config.knowledgeLinkCheck +
 * config.statusCheck + config.contextExport): the offline learning loop.
 */
export const knowledgeSlice = {
  // Offline context builder (issue #51): distills stored interactions into
  // durable context_digests on a ~daily cadence. Off by default; when on,
  // each run makes AT MOST CONTEXT_BUILDER_MAX_SUMMARIES short tool-less
  // model calls (hard cap enforced in code) and is skipped entirely while
  // the usage-alert threshold is breached.
  CONTEXT_BUILDER_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  CONTEXT_BUILDER_WINDOW_DAYS: z.coerce.number().int().positive().max(30).default(1),
  CONTEXT_BUILDER_MAX_SUMMARIES: z.coerce.number().int().positive().max(20).default(5),
  // k-floor: a cluster needs at least this many distinct authors to be
  // digested, so a digest can't become a one-person profile. Never below 2.
  CONTEXT_BUILDER_MIN_DISTINCT_USERS: z.coerce.number().int().min(2).default(3),
  // Knowledge-candidate generation (issue #102, the deferred half of #51):
  // rides the existing builder run's per-digest summarisation call — no new
  // job, no extra model call, so the documented CONTEXT_BUILDER_MAX_SUMMARIES
  // worst case is unchanged with this on. Off by default, and off whenever
  // the builder itself is off. Candidates are review-gated (admin-only,
  // accept_knowledge_candidate) — this flag only controls whether they're
  // ever drafted.
  CONTEXT_CANDIDATES_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // How similar an existing `knowledge` entry must be to a proposed topic
  // before that topic counts as ALREADY COVERED and the proposal is refused
  // (`findKnowledgeCoveringTopic`).
  //
  // Deliberately NOT the #95 retrieval floor
  // (KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD, 0.35), which is what this used to
  // be. That floor answers "is this entry worth SHOWING someone who asked?" —
  // a generous bar, because a marginally-relevant hit costs a reader a glance.
  // Coverage answers "is this contribution redundant, so we refuse it?" — and
  // at 0.35 a member's genuinely new tip is rejected as a duplicate of a
  // loosely-related entry. That is a failure the member sees and the
  // maintainer never does.
  //
  // Nor is it the 0.92 duplicate floor. Both existing 0.92 comparisons are
  // LIKE-vs-LIKE (entry-vs-entry in saveKnowledge's nudge, topic-vs-topic in
  // candidateTopicAlreadyReviewed). This one is CROSS-SHAPE: a short topic
  // phrase against `embed(title + "\n" + content)` of a whole entry, where
  // cosine similarity runs systematically lower for the same semantic match.
  // Reusing 0.92 would mean the guard effectively never fires — silently
  // disabling it rather than tightening it.
  //
  // So it sits between, and the default is a judgement call rather than a
  // measured optimum — which is precisely why it is a knob. The two failure
  // directions are asymmetric: too HIGH merely lets a redundant candidate
  // reach the admin review queue, where a human declines it in one click; too
  // LOW refuses a real contribution and tells a member their tip is a
  // duplicate when it is not. Tune upward freely; tune downward with evidence
  // (every decision is logged with the observed similarity — see
  // findKnowledgeCoveringTopic).
  KNOWLEDGE_COVERAGE_SIMILARITY_THRESHOLD: z.coerce.number().min(0).max(1).default(0.6),
  // Close the answered-question -> knowledge-base loop (issue #726,
  // CAPABILITY-IDEAS.md §D2): when a member rates a helpful:true, UNGROUNDED
  // reply (no meta->>'knowledgeEntryId'), rate_answer drafts a
  // knowledge_candidates row from the preceding question/answer via the SAME
  // createKnowledgeTip/candidateTopicAlreadyReviewed/findKnowledgeCoveringTopic
  // path suggest_knowledge (#633) uses — no new table, rate-limit constant, or
  // model call. Off by default, same convention as every other opt-in
  // behavioural flag above; disabled, rate_answer is byte-identical to today.
  KNOWLEDGE_ANSWER_CANDIDATE_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Daily knowledge refresh: a scheduled job web-researches a small fixed set
  // of fast-moving Claude/Anthropic topics and writes the briefings straight
  // into the knowledge base (one upserted entry per topic, clearly marked
  // auto-generated). OFF by default. NOTE: unlike knowledge candidates, this
  // path has NO human review gate — auto entries are labelled as machine-
  // researched/unverified precisely because of that (see docs/SECURITY.md).
  KNOWLEDGE_REFRESH_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Max agentic turns for one topic's web-research call (bounds cost).
  KNOWLEDGE_REFRESH_MAX_TURNS: z.coerce.number().int().positive().max(30).default(10),
  // Docs ingest: backfill a documentation set into the knowledge base as RAG
  // chunks (provenance 'docs'), refreshed ~weekly with a content diff so only
  // changed sections re-embed. OFF by default. Reads ONE configured source
  // over HTTPS (an llms.txt-style index → per-page .md); no model in the loop.
  DOCS_INGEST_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // The machine-readable docs index (an llms.txt-style URL). NO DEFAULT: a
  // framework must not ship one vendor's documentation URL as the fallback
  // for every agent built on it — community-agent defaulted this to
  // `https://platform.claude.com/llms.txt`, which is deployment config, not
  // framework config. Required whenever DOCS_INGEST_ENABLED is on (see
  // knowledgeRefinements), so the feature fails at boot rather than silently
  // ingesting nothing.
  DOCS_INGEST_INDEX_URL: z
    .string()
    .url()
    .startsWith('https://', 'DOCS_INGEST_INDEX_URL must be https')
    .optional(),
  // Safety caps so a bloated index can't run away (pages fetched, chunks written).
  DOCS_INGEST_MAX_PAGES: z.coerce.number().int().positive().max(5000).default(2500),
  DOCS_INGEST_MAX_CHUNKS: z.coerce.number().int().positive().max(60000).default(20000),
  // Concurrent page fetches — kept small to be polite to the docs host.
  DOCS_INGEST_CONCURRENCY: z.coerce.number().int().positive().max(16).default(5),
  // Doc-path prefixes to EXCLUDE from ingest (comma-separated, matched against
  // the page path, e.g. "api/go"). Default drops the auto-generated per-language
  // SDK/CLI reference — ~90% of the corpus by volume and near-useless for a chat
  // bot — keeping the conceptual guides + core API. Set empty to ingest all.
  DOCS_INGEST_EXCLUDE_PATHS: z
    .string()
    .default('api/go,api/csharp,api/java,api/python,api/typescript,api/ruby,api/php,api/cli,api/compliance'),
  // Dead-URL skipping (issue #611, the growth path #613 deferred): after this
  // many CONSECUTIVE runs in which a page URL fails to fetch, it is reported
  // once and then skipped instead of being re-fetched every run — the upstream
  // index habitually lists a tranche of pages that don't exist. 0 disables the
  // skipping entirely (every listed page is fetched every run, as before).
  // Default 3 is deliberately conservative: the job runs ~weekly, so a URL must
  // fail for ~3 weeks before it is skipped at all.
  DOCS_INGEST_DEAD_URL_RUNS: z.coerce.number().int().min(0).max(100).default(3),
  // How long a skipped (dead) URL stays skipped before ONE re-probe. This is
  // what makes the skip self-healing: if upstream restores the page, the next
  // re-probe succeeds, its failure row is deleted, and it returns to the normal
  // fetch set with no operator action. Never 0 — a 0-day cooldown would re-probe
  // every run and defeat the point.
  DOCS_INGEST_DEAD_URL_RECHECK_DAYS: z.coerce.number().int().positive().max(365).default(30),
  // Release/deprecation watcher (issue #733): surface docsIngest's own
  // weekly diff of Anthropic release-notes/model-deprecation pages in the
  // member digest, instead of discarding the "which page changed" signal.
  // No new fetch — purely a read over rows docsIngest already wrote.
  // Inert (permanently-empty section) unless DOCS_INGEST_ENABLED is also on.
  RELEASE_WATCH_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Doc-path prefixes to INCLUDE (comma-separated, matched against the same
  // page path docsIngest computes). Default is the exact release-notes/
  // model-whats-new/model-deprecations prefixes confirmed live against
  // Anthropic's docs index at proposal time; adjustable if Anthropic
  // restructures the docs site.
  RELEASE_WATCH_DOC_PATHS: z
    .string()
    .default('release-notes,about-claude/models/whats-new,about-claude/model-deprecations'),
  // Knowledge link-rot check (issue #448): a weekly background job HEAD-checks
  // every knowledge entry's sourceUrl and flags dead citations for admin
  // review (list_knowledge sourceUnreachable filter). OFF by default, matching
  // every other opt-in background poll in this repo. No model in the loop —
  // see src/context/linkCheck.ts for the SSRF-hardened fetch/classify logic.
  KNOWLEDGE_LINK_CHECK_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Anthropic status check (issue #206): poll Anthropic's own public status
  // page on a background timer and expose the cached result via the
  // member-tier check_status tool, so "is this me or an Anthropic incident"
  // gets an authoritative answer without widening WebSearch (admin+ only)
  // to every member. OFF by default, matching every other opt-in background
  // poll in this repo. No model in the fetch/parse loop.
  STATUS_CHECK_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // The upstream Statuspage-format summary endpoint. NO DEFAULT, for the same
  // reason as DOCS_INGEST_INDEX_URL (community-agent defaulted it to
  // `https://status.claude.com/api/v2/summary.json`). Required whenever
  // STATUS_CHECK_ENABLED is on. Same https-only enforcement — this is
  // config, never user/chat-supplied.
  STATUS_CHECK_API_URL: z
    .string()
    .url()
    .startsWith('https://', 'STATUS_CHECK_API_URL must be https')
    .optional(),
  // How often to re-poll. A member's turn only ever reads the in-memory
  // cache — it never triggers a live fetch.
  STATUS_CHECK_POLL_MINUTES: z.coerce.number().int().positive().max(1440).default(5),
  // Anonymised community-context export (issue #53): render digests into a
  // file the research loop can read. Off by default. The export applies its
  // own k-floor and PII scrub — see src/context/export.ts and SECURITY.md for
  // the egress boundary.
  //
  // The default path is untracked/git-ignored (issue #108): the *committed*
  // docs/COMMUNITY-CONTEXT.md is a human artefact (#53), refreshed only by a
  // human running `npm run export:context` — pointed at the docs file if they
  // want to overwrite it — and reviewing + committing the result. If this
  // defaulted to a tracked path, the in-process exporter would dirty a
  // tracked file on the server after every producing builder run, and
  // scripts/redeploy.sh's clean-tree check would then permanently abort the
  // nightly redeploy.
  CONTEXT_EXPORT_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  CONTEXT_EXPORT_WINDOW_DAYS: z.coerce.number().int().positive().max(90).default(30),
  CONTEXT_EXPORT_MIN_DISTINCT_USERS: z.coerce.number().int().min(2).default(3),
  CONTEXT_EXPORT_PATH: z.string().default('var/community-context.md'),
};

type KnowledgeEnv = z.infer<z.ZodObject<typeof knowledgeSlice>>;

/**
 * Both URLs above are deployment config with no framework-safe default, so
 * the fail-closed half lives here: turning a fetcher ON without telling it
 * WHERE to fetch from is a boot error, not a silently no-op background job.
 */
export const knowledgeRefinements: EnvRefinement<KnowledgeEnv>[] = [
  {
    check: (e) => e.DOCS_INGEST_ENABLED !== true || e.DOCS_INGEST_INDEX_URL !== undefined,
    params: {
      message: 'DOCS_INGEST_INDEX_URL is required when DOCS_INGEST_ENABLED is true',
      path: ['DOCS_INGEST_INDEX_URL'],
    },
  },
  {
    check: (e) => e.STATUS_CHECK_ENABLED !== true || e.STATUS_CHECK_API_URL !== undefined,
    params: {
      message: 'STATUS_CHECK_API_URL is required when STATUS_CHECK_ENABLED is true',
      path: ['STATUS_CHECK_API_URL'],
    },
  },
];
