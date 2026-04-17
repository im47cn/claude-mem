/**
 * CompiledSummaryStore - Query and upsert compiled summaries
 *
 * Implements GBrain's "Compiled Truth" pattern:
 * - compiled_text is REWRITTEN (not appended) on new evidence
 * - observation_ids provides full traceability
 * - confidence signals reliability based on evidence count
 */

import { Database } from 'bun:sqlite';
import type {
  CompiledSummaryRow,
  CompiledSummaryInput,
  CompiledSummarySearchResult,
} from './types.js';
import { logger } from '../../../utils/logger.js';

export interface CompiledSummarySearchOptions {
  project?: string;
  entityType?: CompiledSummaryRow['entity_type'];
  limit?: number;
}

export class CompiledSummaryStore {
  constructor(private db: Database) {}

  /**
   * Insert or update a compiled summary by topic.
   * REWRITE semantics: if a summary for this topic exists, replace it entirely.
   */
  upsert(input: CompiledSummaryInput): number {
    const now = Date.now();
    const observationIdsJson = JSON.stringify(input.observation_ids);
    const confidence = input.confidence
      ?? Math.min(0.5 + input.observation_ids.length * 0.1, 1.0);

    // Check if topic already exists
    const existing = this.db.query<{ id: number }, [string]>(
      `SELECT id FROM compiled_summaries WHERE topic = ?`
    ).get(input.topic);

    if (existing) {
      // REWRITE: update existing summary
      this.db.query(
        `UPDATE compiled_summaries
         SET compiled_text = ?, confidence = ?, observation_ids = ?,
             entity_type = ?, project = ?, updated_at = ?
         WHERE id = ?`
      ).run(
        input.compiled_text,
        confidence,
        observationIdsJson,
        input.entity_type,
        input.project ?? null,
        now,
        existing.id
      );
      logger.debug('COMPILED', `Rewrote compiled summary: ${input.topic}`, {});
      return existing.id;
    }

    // Create new
    const result = this.db.query(
      `INSERT INTO compiled_summaries
       (topic, entity_type, compiled_text, confidence, observation_ids,
        project, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      input.topic,
      input.entity_type,
      input.compiled_text,
      confidence,
      observationIdsJson,
      input.project ?? null,
      now,
      now
    );

    logger.debug('COMPILED', `Created compiled summary: ${input.topic}`, {});
    return Number(result.lastInsertRowid);
  }

  /**
   * Get a compiled summary by ID
   */
  getById(id: number): CompiledSummaryRow | null {
    return this.db.query<CompiledSummaryRow, [number]>(
      `SELECT * FROM compiled_summaries WHERE id = ?`
    ).get(id) ?? null;
  }

  /**
   * Find compiled summaries by exact topic
   */
  findByTopic(topic: string): CompiledSummaryRow[] {
    return this.db.query<CompiledSummaryRow, [string]>(
      `SELECT * FROM compiled_summaries WHERE topic = ?
       ORDER BY updated_at DESC`
    ).all(topic);
  }

  /**
   * Search compiled summaries by text (topic + compiled_text)
   */
  searchByText(
    query: string,
    opts: CompiledSummarySearchOptions = {}
  ): CompiledSummarySearchResult[] {
    const limit = opts.limit ?? 10;
    const conditions: string[] = [];
    const params: any[] = [];

    if (query && query.trim()) {
      conditions.push(`(topic LIKE ? OR compiled_text LIKE ?)`);
      const likePattern = `%${query.trim()}%`;
      params.push(likePattern, likePattern);
    }

    if (opts.project) {
      conditions.push(`project = ?`);
      params.push(opts.project);
    }

    if (opts.entityType) {
      conditions.push(`entity_type = ?`);
      params.push(opts.entityType);
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    params.push(limit);

    const rows = this.db.query<CompiledSummaryRow, any[]>(
      `SELECT * FROM compiled_summaries ${whereClause}
       ORDER BY confidence DESC, updated_at DESC
       LIMIT ?`
    ).all(...params);

    return rows.map(row => ({
      ...row,
      observation_count: JSON.parse(row.observation_ids).length,
    }));
  }

  /**
   * Get all compiled summaries for a project
   */
  getByProject(
    project: string,
    limit: number = 10
  ): CompiledSummarySearchResult[] {
    return this.searchByText('', { project, limit });
  }

  /**
   * Get global compiled summaries (no project scope)
   */
  getGlobal(
    entityTypes?: string[],
    limit: number = 5
  ): CompiledSummaryRow[] {
    if (entityTypes && entityTypes.length > 0) {
      const placeholders = entityTypes.map(() => '?').join(',');
      return this.db.query<CompiledSummaryRow, any[]>(
        `SELECT * FROM compiled_summaries
         WHERE project IS NULL AND entity_type IN (${placeholders})
         ORDER BY confidence DESC, updated_at DESC
         LIMIT ?`
      ).all(...entityTypes, limit);
    }

    return this.db.query<CompiledSummaryRow, [number]>(
      `SELECT * FROM compiled_summaries
       WHERE project IS NULL
       ORDER BY confidence DESC, updated_at DESC
       LIMIT ?`
    ).all(limit);
  }

  /**
   * Delete a compiled summary
   */
  delete(id: number): boolean {
    const result = this.db.query(
      `DELETE FROM compiled_summaries WHERE id = ?`
    ).run(id);
    return result.changes > 0;
  }

  /**
   * Count all compiled summaries
   */
  count(): number {
    const row = this.db.query<{ count: number }, []>(
      `SELECT COUNT(*) as count FROM compiled_summaries`
    ).get();
    return row?.count ?? 0;
  }
}
