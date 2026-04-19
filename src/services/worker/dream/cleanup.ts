/**
 * Phase 3: Stale Observation Cleanup
 *
 * Three sub-phases:
 * 3a: Find and merge duplicate observations (content_hash or high Jaccard)
 * 3b: Demote old observations with low reference count
 * 3c: Detect contradictions and flag for review
 *
 * Zero API cost — all operations are local SQL queries + keyword analysis.
 */

import { Database } from 'bun:sqlite';
import type { CleanupReport } from './types.js';
import { extractKeywords, keywordSimilarity } from './clustering.js';
import { logger } from '../../../utils/logger.js';

interface ObservationRow {
  id: number;
  memory_session_id: string;
  project: string;
  title: string | null;
  subtitle: string | null;
  narrative: string | null;
  facts: string | null;
  concepts: string | null;
  type: string;
  content_hash: string | null;
  created_at_epoch: number;
  demoted: number;
}

/**
 * Phase 3a: Find duplicate observations by content_hash
 * Returns groups of observation IDs that share the same hash
 */
function findDuplicatesByHash(db: Database): number[][] {
  const rows = db.query<{ content_hash: string; ids: string }, []>(
    `SELECT content_hash, GROUP_CONCAT(id) as ids
     FROM observations
     WHERE content_hash IS NOT NULL
       AND demoted = 0
     GROUP BY content_hash
     HAVING COUNT(*) > 1`
  ).all();

  return rows.map(row => row.ids.split(',').map(Number));
}

/**
 * Phase 3a: Merge duplicate groups — keep newest, demote others
 */
function mergeDuplicateGroup(db: Database, ids: number[]): number {
  if (ids.length <= 1) return 0;

  // Keep the most recent observation (highest id = newest)
  const sorted = [...ids].sort((a, b) => b - a);
  const keep = sorted[0];
  const demoteIds = sorted.slice(1);

  const placeholders = demoteIds.map(() => '?').join(',');
  db.query(
    `UPDATE observations SET demoted = 1 WHERE id IN (${placeholders})`
  ).run(...demoteIds);

  logger.debug('DREAM', `Merged duplicates: kept #${keep}, demoted ${demoteIds.length} others`);
  return demoteIds.length;
}

/**
 * Phase 3b: Demote stale observations
 * Criteria: older than staleDays, not referenced by any compiled summary, not already demoted
 */
function demoteStaleObservations(
  db: Database,
  staleDays: number = 90
): number {
  const cutoff = Date.now() - (staleDays * 24 * 60 * 60 * 1000);

  // Find observations older than cutoff that are NOT referenced by compiled summaries
  // and are not already demoted
  const staleObs = db.query<{ id: number }, [number]>(
    `SELECT o.id FROM observations o
     WHERE o.created_at_epoch < ?
       AND o.demoted = 0
       AND NOT EXISTS (
         SELECT 1 FROM compiled_summaries cs
         WHERE (cs.observation_ids LIKE '[' || o.id || ']'
            OR cs.observation_ids LIKE '[' || o.id || ',%'
            OR cs.observation_ids LIKE '%,' || o.id || ']'
            OR cs.observation_ids LIKE '%,' || o.id || ',%')
       )`
  ).all(cutoff);

  if (staleObs.length === 0) return 0;

  const ids = staleObs.map(o => o.id);
  const placeholders = ids.map(() => '?').join(',');
  db.query(
    `UPDATE observations SET demoted = 1 WHERE id IN (${placeholders})`
  ).run(...ids);

  logger.info('DREAM', `Demoted ${ids.length} stale observations (older than ${staleDays} days)`);
  return ids.length;
}

/**
 * Phase 3c: Detect potential contradictions between observations
 * Simple heuristic: observations with same project + high keyword overlap
 * but different types (e.g., one says "use X", another says "don't use X")
 *
 * Returns count of flagged contradictions
 */
function detectContradictions(db: Database): number {
  // Get recent non-demoted observations with content
  const observations = db.query<ObservationRow, []>(
    `SELECT id, memory_session_id, project, title, subtitle, narrative,
            facts, concepts, type, content_hash, created_at_epoch, demoted
     FROM observations
     WHERE demoted = 0
       AND (title IS NOT NULL OR narrative IS NOT NULL)
     ORDER BY created_at_epoch DESC
     LIMIT 500`
  ).all();

  if (observations.length < 2) return 0;

  // Extract keywords for each observation
  const withKeywords = observations.map(obs => ({
    obs,
    keywords: extractKeywords(obs),
  }));

  let flagged = 0;
  const now = Date.now();

  // Compare pairs within the same project
  for (let i = 0; i < withKeywords.length; i++) {
    for (let j = i + 1; j < withKeywords.length; j++) {
      const a = withKeywords[i];
      const b = withKeywords[j];

      // Only compare within same project
      if (a.obs.project !== b.obs.project) continue;

      // High keyword overlap suggests same topic
      const similarity = keywordSimilarity(a.keywords, b.keywords);
      if (similarity < 0.5) continue;

      // Different types might indicate contradiction
      // (e.g., a "decision" followed by a conflicting "decision")
      if (a.obs.type === b.obs.type && a.obs.type === 'decision') {
        // Check if already flagged
        const existing = db.query<{ id: number }, [number, number]>(
          `SELECT id FROM contradictions
           WHERE (observation_id_a = ? AND observation_id_b = ?)
              OR (observation_id_a = ? AND observation_id_b = ?)`
        ).get(a.obs.id, b.obs.id, b.obs.id, a.obs.id);

        if (!existing) {
          db.query(
            `INSERT INTO contradictions (observation_id_a, observation_id_b, description, resolved, created_at)
             VALUES (?, ?, ?, 0, ?)`
          ).run(
            a.obs.id,
            b.obs.id,
            `High similarity (${(similarity * 100).toFixed(0)}%) between decisions in project "${a.obs.project}"`,
            now
          );
          flagged++;
        }
      }
    }
  }

  if (flagged > 0) {
    logger.info('DREAM', `Flagged ${flagged} potential contradictions for review`);
  }

  return flagged;
}

/**
 * Phase 3 entry point: run all cleanup sub-phases
 */
export function runCleanup(
  db: Database,
  options: { staleDays?: number } = {}
): CleanupReport {
  const report: CleanupReport = { merged: 0, demoted: 0, flagged: 0 };

  // 3a: Merge duplicates by content_hash
  const duplicateGroups = findDuplicatesByHash(db);
  for (const group of duplicateGroups) {
    report.merged += mergeDuplicateGroup(db, group);
  }

  // 3b: Demote stale observations
  report.demoted = demoteStaleObservations(db, options.staleDays ?? 90);

  // 3c: Detect contradictions
  report.flagged = detectContradictions(db);

  return report;
}

// Export sub-functions for testing
export { findDuplicatesByHash, mergeDuplicateGroup, demoteStaleObservations, detectContradictions };
