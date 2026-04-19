/**
 * Phase 4: Index Refresh
 *
 * Ensures search indexes are current after dream cycle modifications:
 * - FTS5: Signal SQLite to rebuild full-text index
 * - ChromaDB: Re-embed compiled summaries via ChromaSync
 *
 * Zero API cost for FTS5; ChromaDB re-embed uses embedding API if enabled.
 */

import { Database } from 'bun:sqlite';
import type { RefreshReport } from './types.js';
import { logger } from '../../../utils/logger.js';

/**
 * Rebuild FTS5 index by running the rebuild command
 * This is a SQLite built-in operation — no API cost
 */
function rebuildFTS5(db: Database): boolean {
  try {
    // Check if observations_fts table exists
    const ftsExists = db.query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'`
    ).get();

    if (!ftsExists) {
      logger.debug('DREAM', 'No FTS5 table found, skipping rebuild');
      return false;
    }

    // FTS5 rebuild command
    db.query(`INSERT INTO observations_fts(observations_fts) VALUES('rebuild')`).run();
    logger.info('DREAM', 'FTS5 index rebuilt successfully');
    return true;
  } catch (error) {
    logger.error('DREAM', 'FTS5 rebuild failed', {}, error as Error);
    return false;
  }
}

/**
 * Re-index compiled summaries in ChromaDB (if available)
 * This is best-effort — ChromaDB may not be configured
 *
 * TODO: ChromaSync does not yet have an API for indexing compiled_summaries
 * (no syncSingleRecord static method exists). When ChromaSync is extended to
 * support arbitrary document types, implement this function to embed compiled
 * summaries for semantic search. Tracked as a separate work item.
 */
async function reindexCompiledSummaries(_db: Database): Promise<number> {
  // ChromaSync.syncSingleRecord does not exist — ChromaDB indexing of compiled
  // summaries is not yet implemented. Skip silently.
  logger.debug('DREAM', 'ChromaDB re-indexing of compiled summaries not yet implemented — skipping');
  return 0;
}

/**
 * Phase 4 entry point: refresh all search indexes
 */
export async function runRefresh(db: Database): Promise<RefreshReport> {
  const report: RefreshReport = {
    fts5Rebuilt: false,
    compiledSummariesIndexed: 0,
  };

  // Rebuild FTS5 index
  report.fts5Rebuilt = rebuildFTS5(db);

  // Re-index compiled summaries in ChromaDB
  report.compiledSummariesIndexed = await reindexCompiledSummaries(db);

  return report;
}

// Export for testing
export { rebuildFTS5, reindexCompiledSummaries };
