import type { Queryable } from '../storage/repository/shared.js';

/**
 * Reporting a resident agent's liveness and spend to a bosun supervisor.
 *
 * bosun (swampratnz/bosun) supervises a fleet of agents. Its v1 contract is a
 * *pull* one — a worker claims tasks from a queue — which a resident agent can
 * never satisfy: an agent-base deployment sits on a Discord gateway socket
 * waiting for work to arrive, so there is no queue for it to claim from. bosun
 * grew a `mode: "service"` type for exactly that shape, where liveness comes
 * from an HTTP health probe rather than from claiming.
 *
 * A probe answers "is it up". It cannot answer "what did it spend", and that
 * is the one thing bosun's daily budget caps need. This module closes that
 * gap, and it is the whole reason it exists.
 *
 * ## Why it reads the database rather than the turn path
 *
 * The obvious implementation taps each turn as it finishes. This one does not,
 * deliberately. `router.ts` already writes a per-turn `meta->'modelUsage'` map
 * to `interactions`, and `adminStats` already aggregates it — so the spend is
 * durable, queryable, and computed by code that is already tested. Reading it
 * back costs one query per heartbeat and touches neither the router spine nor
 * `core.ts`; tapping the turn path would touch both, to learn something the
 * database already knows.
 *
 * It also means a missed heartbeat loses nothing: the next one picks up the
 * same rows, because the watermark only advances on a successful report.
 *
 * ## What it is not
 *
 * Not a scheduler, not a task queue, and not a way for bosun to drive this
 * agent. It is one-directional: this process tells a supervisor what it did.
 * Nothing bosun returns is executed here.
 */

/** Resolved when every required variable is present; `undefined` leaves the whole module inert. */
export interface FleetHeartbeatConfig {
  agentId: string;
  agentType: string;
  /** Supervisor base URL, no trailing slash. Localhost or a tailnet address. */
  supervisorUrl: string;
  intervalMs: number;
  /** Per-request timeout. A supervisor that is down must not wedge the agent. */
  timeoutMs: number;
  /**
   * Bearer token for bosun's agent API, from `FLEET_SUPERVISOR_TOKEN`.
   *
   * Optional, because it depends on WHERE the supervisor is. bosun's operator
   * API is loopback-only and unauthenticated — an agent on the same box needs
   * no token. Its agent API, the one a resident agent on another box reaches,
   * serves two routes on a named address behind a per-type token. So: same
   * box, no token; another box, token required.
   */
  token?: string;
}

/**
 * Read the fleet configuration a bosun supervisor injects at spawn.
 *
 * Returns `undefined` unless all three identity variables are present, and
 * that is the normal case: an agent-base deployment not running under bosun
 * gets exactly the behaviour it had before this module existed. There is no
 * enable flag, because the presence of a supervisor to report to *is* the
 * flag — a half-configured agent should stay inert rather than report to a URL
 * someone forgot to finish setting.
 */
export function readFleetHeartbeatConfig(env: NodeJS.ProcessEnv): FleetHeartbeatConfig | undefined {
  const agentId = env.FLEET_AGENT_ID;
  const agentType = env.FLEET_AGENT_TYPE;
  const supervisorUrl = env.FLEET_SUPERVISOR_URL;
  if (!agentId || !agentType || !supervisorUrl) return undefined;

  const token = env.FLEET_SUPERVISOR_TOKEN?.trim();
  const seconds = Number(env.FLEET_HEARTBEAT_SECONDS ?? 30);
  const intervalMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 30_000;
  return {
    agentId,
    agentType,
    supervisorUrl: supervisorUrl.replace(/\/$/, ''),
    intervalMs,
    ...(token ? { token } : {}),
    // Comfortably inside the interval: a request still in flight when the next
    // tick fires would stack up against a wedged supervisor.
    timeoutMs: Math.max(2_000, Math.min(10_000, Math.floor(intervalMs / 3))),
  };
}

/** One model's spend since the watermark, in the shape bosun's /heartbeat accepts. */
export interface FleetUsageEntry {
  model: string;
  /**
   * Pre-priced, because that is all the database holds: `meta->'modelUsage'`
   * is a flat `{model: costUsd}` map and no token counts survive into it.
   * bosun's UsageEntry takes `costUsd` for exactly this reporter.
   */
  costUsd: number;
}

/**
 * Spend recorded since `since`, per model.
 *
 * Same table, direction filter and JSONB expansion as `adminStats`'s
 * `costByModel` aggregate — `jsonb_each_text` is strict, so a row with no
 * `modelUsage` key contributes nothing rather than needing an explicit guard.
 * The window is `> since` rather than a rolling interval so consecutive
 * reports cannot double-count the same row.
 */
export async function spendSince(db: Queryable, since: Date): Promise<FleetUsageEntry[]> {
  const { rows } = await db.query(
    `SELECT mu.key AS model, coalesce(sum(mu.value::numeric), 0) AS cost
       FROM interactions
       CROSS JOIN LATERAL jsonb_each_text(meta->'modelUsage') AS mu(key, value)
      WHERE direction = 'outbound' AND created_at > $1
      GROUP BY mu.key`,
    [since],
  );
  return (rows as Array<{ model: string; cost: string }>)
    .map((r) => ({ model: r.model, costUsd: Number(r.cost) }))
    .filter((e) => Number.isFinite(e.costUsd) && e.costUsd > 0);
}

export interface FleetHeartbeatDeps {
  db: Queryable;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
  log?: (message: string, err?: unknown) => void;
}

/**
 * The reporter. Owns its watermark and its timer; `stop()` is idempotent.
 *
 * Every network failure is swallowed and logged. A supervisor being down is
 * not this agent's problem to escalate — the agent's job is answering Discord,
 * and bosun's own health probe already notices a silent agent. Throwing here
 * would turn an observability outage into a service outage.
 */
export class FleetHeartbeat {
  private readonly cfg: FleetHeartbeatConfig;
  private readonly deps: Required<Pick<FleetHeartbeatDeps, 'db'>> & FleetHeartbeatDeps;
  private timer?: ReturnType<typeof setInterval>;
  /** Rows after this instant have not been reported yet. Advances only on success. */
  private watermark: Date;
  private inFlight = false;

  constructor(cfg: FleetHeartbeatConfig, deps: FleetHeartbeatDeps) {
    this.cfg = cfg;
    this.deps = deps;
    this.watermark = (deps.now ?? (() => new Date()))();
  }

  private get fetchImpl(): typeof fetch {
    return this.deps.fetchImpl ?? fetch;
  }

  private log(message: string, err?: unknown): void {
    this.deps.log?.(message, err);
  }

  private async post(path: string, body: unknown): Promise<boolean> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.cfg.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.cfg.supervisorUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.cfg.token ? { authorization: `Bearer ${this.cfg.token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      // A refusal is logged, not swallowed. Everything about this module is
      // built so a supervisor problem cannot become an agent problem — which
      // makes a silent 401 the dangerous case: the agent runs perfectly, the
      // spend reads zero, and nothing anywhere says why. 401 gets its own
      // line because its cause is always the same two things.
      if (!res.ok) {
        this.log(
          res.status === 401
            ? `fleet heartbeat: ${path} refused (401) — check FLEET_SUPERVISOR_TOKEN matches this type's agentTokenRef on the supervisor`
            : `fleet heartbeat: ${path} refused (${res.status})`,
        );
      }
      return res.ok;
    } catch (err) {
      this.log(`fleet heartbeat: ${path} failed`, err);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Tell the supervisor this agent is up. bosun flips the registry row to
   * `running`; without it the row sits in `starting` and is never health-checked.
   */
  async register(): Promise<boolean> {
    return this.post(`/agents/${encodeURIComponent(this.cfg.agentId)}/ready`, { pid: process.pid });
  }

  /**
   * One heartbeat: report spend since the watermark, and advance it only if
   * the supervisor accepted the report. A failed post leaves the window open
   * so the next tick re-reports the same rows rather than dropping them.
   */
  async beat(): Promise<void> {
    if (this.inFlight) return; // a slow supervisor must not stack requests
    this.inFlight = true;
    const now = (this.deps.now ?? (() => new Date()))();
    try {
      let usage: FleetUsageEntry[] = [];
      try {
        usage = await spendSince(this.deps.db, this.watermark);
      } catch (err) {
        // A database blip must not stop the liveness signal: still beat, with
        // no usage, so bosun does not mistake a query failure for a dead agent.
        this.log('fleet heartbeat: spend query failed; reporting liveness only', err);
      }
      const ok = await this.post('/heartbeat', {
        agentId: this.cfg.agentId,
        ...(usage.length > 0 ? { usage } : {}),
      });
      if (ok) this.watermark = now;
    } finally {
      this.inFlight = false;
    }
  }

  /** Register, then beat on the configured interval. Returns the timer, or null if already started. */
  start(): ReturnType<typeof setInterval> | null {
    if (this.timer) return null;
    void this.register().then((ok) => {
      if (!ok) this.log('fleet heartbeat: registration was not accepted; will keep heartbeating anyway');
    });
    this.timer = setInterval(() => void this.beat(), this.cfg.intervalMs);
    // Never hold the process open on this alone.
    this.timer.unref?.();
    return this.timer;
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}

/**
 * Start the reporter if a supervisor is configured, otherwise do nothing.
 *
 * The shape a deployment wants at startup: call it unconditionally, and it is
 * a no-op outside a bosun fleet.
 */
export function startFleetHeartbeat(env: NodeJS.ProcessEnv, deps: FleetHeartbeatDeps): FleetHeartbeat | null {
  const cfg = readFleetHeartbeatConfig(env);
  if (!cfg) return null;
  const hb = new FleetHeartbeat(cfg, deps);
  hb.start();
  return hb;
}
