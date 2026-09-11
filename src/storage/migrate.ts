import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootConfig } from '../config/boot.js';
import { logger } from '../logger.js';
import { closeDb, pool } from './db.js';
import { loadSchemaSql } from './schema/manifest.js';

/**
 * Apply the schema (src/storage/schema/ fragments, concatenated in manifest
 * order). Idempotent — every statement uses IF NOT EXISTS. The embedding
 * dimension is injected from config so the vector columns always match the
 * configured model. Still ONE pool.query: the single multi-statement query is
 * what rolls the whole migration back on any failure.
 */
/**
 * One module-contributed schema fragment. `sql` is concatenated AFTER every
 * base fragment (base-first ordering is part of the createAgent contract):
 * a module's tables may reference base tables, never the other way round.
 */
export interface ModuleMigrationFragment {
  /** `<module>/<file>` — appears in the separator comment, so a failed
   * migration's error offset is attributable to a fragment. */
  name: string;
  sql: string;
}

/** Postgres `deadlock_detected`. */
const DEADLOCK = '40P01';

/**
 * Apply the assembled schema as ONE multi-statement query, retrying only when
 * Postgres aborts it as a deadlock victim (40P01).
 *
 * The replay takes ACCESS EXCLUSIVE locks (ALTER TABLE, constraint swaps)
 * across many tables inside one transaction, so anything writing at the same
 * time (the previous process during a deploy, or other test files sharing the
 * CI database) can deadlock with it. Postgres rolls the victim's WHOLE
 * transaction back, so a retry replays from a clean slate and the migration
 * stays atomic. Any other error is thrown at once: only a lost lock race is
 * worth repeating. `query` and `sleep` are injectable for tests.
 */
export async function applySchemaSql(
  sql: string,
  opts: {
    query?: (sql: string) => Promise<unknown>;
    attempts?: number;
    baseDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<void> {
  const query = opts.query ?? ((q: string) => pool.query(q));
  const attempts = opts.attempts ?? 5;
  const baseDelayMs = opts.baseDelayMs ?? 200;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  for (let attempt = 1; ; attempt += 1) {
    try {
      await query(sql);
      return;
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (code !== DEADLOCK || attempt >= attempts) throw err;
      const delayMs = baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * baseDelayMs);
      logger.warn(
        { attempt, attempts, delayMs },
        'Schema apply lost a deadlock; retrying the whole transaction',
      );
      await sleep(delayMs);
    }
  }
}

export async function migrate(moduleFragments: readonly ModuleMigrationFragment[] = []): Promise<void> {
  const base = await loadSchemaSql();
  // ONE multi-statement query, still: that is what makes a mid-file failure
  // roll back the whole migration. Module fragments join the same string
  // rather than getting their own query, so a broken module fragment cannot
  // leave a half-migrated database behind.
  const raw = [base, ...moduleFragments.map((f) => `-- fragment: ${f.name}\n${f.sql}`)].join('\n');
  const sql = raw.replaceAll(':EMBEDDING_DIM', String(bootConfig.db.embeddingDim));

  logger.info(
    { embeddingDim: bootConfig.db.embeddingDim, moduleFragments: moduleFragments.length },
    'Applying database schema',
  );
  await applySchemaSql(sql);
  logger.info('Database schema applied');
}

// Allow running directly: `npm run migrate` (tsx) or `npm run migrate:prod` (node dist).
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  migrate()
    .then(() => closeDb())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err }, 'Migration failed');
      process.exit(1);
    });
}
