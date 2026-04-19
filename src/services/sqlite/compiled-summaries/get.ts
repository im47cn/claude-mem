/**
 * Compiled Summary retrieval functions
 *
 * Query and search compiled summaries. The search integration
 * prefers compiled summaries over raw observations when available.
 */

import { Database } from 'bun:sqlite';
import type { CompiledSummaryRow, CompiledSummarySearchResult, CompiledSummaryEntityType } from '../types.js';
import { logger } from '../../../utils/logger.js';

/**
 * Get a single compiled summary by ID
 */
export function getCompiledSummaryById(
  db: Database,
  id: number
): CompiledSummaryRow | null {
  return db.prepare('SELECT * FROM compiled_summaries WHERE id = ?')
    .get(id) as CompiledSummaryRow | null;
}

/**
 * Get compiled summaries by topic (exact match)
 */
export function getCompiledSummaryByTopic(
  db: Database,
  topic: string,
  project?: string
): CompiledSummaryRow | null {
  if (project) {
    return db.prepare(
      'SELECT * FROM compiled_summaries WHERE topic = ? AND (project = ? OR project IS NULL) ORDER BY updated_at DESC LIMIT 1'
    ).get(topic, project) as CompiledSummaryRow | null;
  }
  return db.prepare(
    'SELECT * FROM compiled_summaries WHERE topic = ? ORDER BY updated_at DESC LIMIT 1'
  ).get(topic) as CompiledSummaryRow | null;
}

/**
 * Search compiled summaries using FTS5 (topic + compiled_text)
 */
export function searchCompiledSummaries(
  db: Database,
  query: string,
  options: {
    project?: string;
    entityType?: CompiledSummaryEntityType;
    includeStale?: boolean;
    limit?: number;
  } = {}
): CompiledSummarySearchResult[] {
  const { project, entityType, includeStale = false, limit = 10 } = options;

  // Check if FTS5 table exists
  try {
    db.prepare("SELECT 1 FROM compiled_summaries_fts LIMIT 1").get();
  } catch {
    // FTS5 not available, fall back to LIKE search
    return searchCompiledSummariesLike(db, query, options);
  }

  const conditions: string[] = [];
  const params: any[] = [];

  // FTS5 match
  conditions.push('compiled_summaries_fts MATCH ?');
  params.push(query);

  // Build WHERE clause for the main table join
  const joinConditions: string[] = [];
  if (project) {
    joinConditions.push('(cs.project = ? OR cs.project IS NULL)');
    params.push(project);
  }
  if (entityType) {
    joinConditions.push('cs.entity_type = ?');
    params.push(entityType);
  }
  if (!includeStale) {
    joinConditions.push('cs.is_stale = 0');
  }

  const joinWhere = joinConditions.length > 0
    ? `AND ${joinConditions.join(' AND ')}`
    : '';

  params.push(limit);

  const sql = `
    SELECT cs.*, rank
    FROM compiled_summaries_fts
    JOIN compiled_summaries cs ON cs.id = compiled_summaries_fts.rowid
    WHERE ${conditions.join(' AND ')}
    ${joinWhere}
    ORDER BY rank
    LIMIT ?
  `;

  const rows = db.prepare(sql).all(...params) as (CompiledSummaryRow & { rank: number })[];

  return rows.map(row => ({
    ...row,
    score: row.rank ? Math.max(0, 1 - Math.abs(row.rank) / 20) : 0.5
  }));
}

/**
 * Fallback LIKE search when FTS5 is not available
 */
function searchCompiledSummariesLike(
  db: Database,
  query: string,
  options: {
    project?: string;
    entityType?: CompiledSummaryEntityType;
    includeStale?: boolean;
    limit?: number;
  } = {}
): CompiledSummarySearchResult[] {
  const { project, entityType, includeStale = false, limit = 10 } = options;

  const conditions: string[] = ['(topic LIKE ? OR compiled_text LIKE ?)'];
  const params: any[] = [`%${query}%`, `%${query}%`];

  if (project) {
    conditions.push('(project = ? OR project IS NULL)');
    params.push(project);
  }
  if (entityType) {
    conditions.push('entity_type = ?');
    params.push(entityType);
  }
  if (!includeStale) {
    conditions.push('is_stale = 0');
  }

  params.push(limit);

  const sql = `
    SELECT *
    FROM compiled_summaries
    WHERE ${conditions.join(' AND ')}
    ORDER BY updated_at DESC
    LIMIT ?
  `;

  return db.prepare(sql).all(...params) as CompiledSummarySearchResult[];
}

/**
 * Get all stale compiled summaries (for recompilation)
 */
export function getStaleCompiledSummaries(
  db: Database,
  options: { project?: string; limit?: number } = {}
): CompiledSummaryRow[] {
  const { project, limit = 50 } = options;

  if (project) {
    return db.prepare(
      'SELECT * FROM compiled_summaries WHERE is_stale = 1 AND (project = ? OR project IS NULL) ORDER BY updated_at ASC LIMIT ?'
    ).all(project, limit) as CompiledSummaryRow[];
  }

  return db.prepare(
    'SELECT * FROM compiled_summaries WHERE is_stale = 1 ORDER BY updated_at ASC LIMIT ?'
  ).all(limit) as CompiledSummaryRow[];
}

/**
 * Get all compiled summaries for a project
 */
export function getCompiledSummariesForProject(
  db: Database,
  project: string,
  options: { includeStale?: boolean; limit?: number } = {}
): CompiledSummaryRow[] {
  const { includeStale = true, limit = 100 } = options;

  const staleClause = includeStale ? '' : 'AND is_stale = 0';

  return db.prepare(`
    SELECT * FROM compiled_summaries
    WHERE (project = ? OR project IS NULL)
    ${staleClause}
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(project, limit) as CompiledSummaryRow[];
}

/**
 * Count compiled summaries (for stats)
 */
export function countCompiledSummaries(
  db: Database,
  options: { project?: string; staleOnly?: boolean } = {}
): number {
  const { project, staleOnly = false } = options;
  const conditions: string[] = [];
  const params: any[] = [];

  if (project) {
    conditions.push('(project = ? OR project IS NULL)');
    params.push(project);
  }
  if (staleOnly) {
    conditions.push('is_stale = 1');
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const row = db.prepare(`SELECT COUNT(*) as cnt FROM compiled_summaries ${where}`).get(...params) as { cnt: number };
  return row.cnt;
}

/**
 * Get observation IDs referenced by a compiled summary
 */
export function getLinkedObservationIds(
  db: Database,
  compiledSummaryId: number
): number[] {
  const row = db.prepare('SELECT observation_ids FROM compiled_summaries WHERE id = ?')
    .get(compiledSummaryId) as { observation_ids: string } | null;

  if (!row) return [];

  try {
    return JSON.parse(row.observation_ids);
  } catch {
    return [];
  }
}
