/**
 * Compiled Summary storage operations
 *
 * Handles CRUD for the compiled_summaries table.
 * Key principle: compiled_text is REWRITTEN (not appended) when new evidence arrives.
 */

import { Database } from 'bun:sqlite';
import { logger } from '../../../utils/logger.js';
import type { CompiledSummaryInput, CompiledSummaryRow } from '../types.js';

/**
 * Create a new compiled summary
 */
export function createCompiledSummary(
  db: Database,
  input: CompiledSummaryInput
): CompiledSummaryRow {
  const now = Date.now();
  const observationIdsJson = JSON.stringify(input.observation_ids);

  const stmt = db.prepare(`
    INSERT INTO compiled_summaries
    (topic, entity_type, compiled_text, confidence, observation_ids, observation_count,
     project, is_stale, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `);

  const result = stmt.run(
    input.topic,
    input.entity_type,
    input.compiled_text,
    input.confidence ?? 0.8,
    observationIdsJson,
    input.observation_ids.length,
    input.project ?? null,
    now,
    now
  );

  const id = Number(result.lastInsertRowid);
  logger.debug('COMPILED', `Created compiled summary id=${id} topic="${input.topic}" obs_count=${input.observation_ids.length}`);

  return {
    id,
    topic: input.topic,
    entity_type: input.entity_type,
    compiled_text: input.compiled_text,
    confidence: input.confidence ?? 0.8,
    observation_ids: observationIdsJson,
    observation_count: input.observation_ids.length,
    project: input.project ?? null,
    is_stale: 0,
    created_at: now,
    updated_at: now,
  };
}

/**
 * REWRITE a compiled summary with new synthesis (not append)
 * This is the core GBrain principle: compiled truth is always rewritten entirely.
 */
export function rewriteCompiledSummary(
  db: Database,
  id: number,
  compiledText: string,
  observationIds: number[],
  confidence?: number
): void {
  const now = Date.now();

  const stmt = db.prepare(`
    UPDATE compiled_summaries
    SET compiled_text = ?,
        observation_ids = ?,
        observation_count = ?,
        confidence = ?,
        is_stale = 0,
        updated_at = ?
    WHERE id = ?
  `);

  stmt.run(
    compiledText,
    JSON.stringify(observationIds),
    observationIds.length,
    confidence ?? 0.8,
    now,
    id
  );

  logger.debug('COMPILED', `Rewrote compiled summary id=${id} obs_count=${observationIds.length}`);
}

/**
 * Mark compiled summaries as stale when new observations arrive
 * that might affect their topics.
 */
export function markStale(
  db: Database,
  topic: string,
  project?: string
): number {
  let stmt;
  if (project) {
    stmt = db.prepare(`
      UPDATE compiled_summaries
      SET is_stale = 1
      WHERE topic = ? AND (project = ? OR project IS NULL)
    `);
    const result = stmt.run(topic, project);
    return result.changes;
  } else {
    stmt = db.prepare(`
      UPDATE compiled_summaries
      SET is_stale = 1
      WHERE topic = ?
    `);
    const result = stmt.run(topic);
    return result.changes;
  }
}

/**
 * Mark a compiled summary as stale by ID
 */
export function markStaleById(db: Database, id: number): void {
  db.prepare('UPDATE compiled_summaries SET is_stale = 1 WHERE id = ?').run(id);
}

/**
 * Delete a compiled summary
 */
export function deleteCompiledSummary(db: Database, id: number): void {
  db.prepare('DELETE FROM compiled_summaries WHERE id = ?').run(id);
}
