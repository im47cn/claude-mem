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
 */
async function reindexCompiledSummaries(db: Database): Promise<number> {
  try {
    // Dynamic import to avoid hard dependency on ChromaSync
    const { ChromaSync } = await import('../../sync/ChromaSync.js');

    // Get compiled summaries that were updated since last dream cycle
    const summaries = db.query<{
      id: number;
      topic: string;
      compiled_text: string;
      project: string | null;
    }, []>(
      `SELECT id, topic, compiled_text, project FROM compiled_summaries
       ORDER BY updated_at DESC
       LIMIT 100`
    ).all();

    if (summaries.length === 0) return 0;

    let indexed = 0;
    for (const summary of summaries) {
      try {
        // Use ChromaSync to embed the compiled summary as a special observation
        await ChromaSync.syncSingleRecord({
          id: `compiled_${summary.id}`,
          text: `[Compiled: ${summary.topic}] ${summary.compiled_text}`,
          project: summary.project || 'global',
          metadata: {
            type: 'compiled_summary',
            topic: summary.topic,
            source_id: summary.id,
          }
        });
        indexed++;
      } catch (err) {
        // Best-effort: skip individual failures
        logger.debug('DREAM', `Failed to re-index compiled summary #${summary.id}`, {}, err as Error);
      }
    }

    if (indexed > 0) {
      logger.info('DREAM', `Re-indexed ${indexed} compiled summaries in ChromaDB`);
    }
    return indexed;
  } catch {
    // ChromaSync not available or not configured — skip silently
    logger.debug('DREAM', 'ChromaDB not available, skipping compiled summary re-indexing');
    return 0;
  }
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
