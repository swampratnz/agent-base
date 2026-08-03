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
  await pool.query(sql);
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
