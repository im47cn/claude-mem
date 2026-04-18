/**
 * DreamCycleRunner - Orchestrates all 4 phases of the dream cycle
 *
 * Phases:
 * 1. Clustering: Group observations by keyword overlap (zero API cost)
 * 2. Compilation: Generate/rewrite compiled summaries via LLM
 * 3. Cleanup: Dedup, demote stale, detect contradictions (zero API cost)
 * 4. Refresh: Rebuild FTS5 + re-embed in ChromaDB
 *
 * Scheduling: setInterval in worker-service.ts (matches existing patterns)
 */

import { Database } from 'bun:sqlite';
import type { ObservationForClustering, DreamCycleReport, DreamCycleRunRow } from './types.js';
import { clusterObservations } from './clustering.js';
import { compileClusters } from './compiler.js';
import { runCleanup } from './cleanup.js';
import { runRefresh } from './refresh.js';
import { CompiledSummaryStore } from '../search/compiled-summaries.js';
import { logger } from '../../../utils/logger.js';

export class DreamCycleRunner {
  private running = false;
  private compiledStore: CompiledSummaryStore;

  constructor(private db: Database) {
    this.compiledStore = new CompiledSummaryStore(db);
  }

  /**
   * Check if a dream cycle is currently running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get observations since the given epoch timestamp
   */
  private getObservationsSince(sinceEpoch: number): ObservationForClustering[] {
    return this.db.query<ObservationForClustering, [number]>(
      `SELECT id, memory_session_id, project, title, subtitle, narrative,
              facts, concepts, type, created_at_epoch
       FROM observations
       WHERE created_at_epoch > ?
         AND demoted = 0
       ORDER BY created_at_epoch ASC`
    ).all(sinceEpoch);
  }

  /**
   * Count observations since the given epoch timestamp
   */
  countObservationsSince(sinceEpoch: number): number {
    const row = this.db.query<{ count: number }, [number]>(
      `SELECT COUNT(*) as count FROM observations
       WHERE created_at_epoch > ? AND demoted = 0`
    ).get(sinceEpoch);
    return row?.count ?? 0;
  }

  /**
   * Get the last completed dream cycle time (epoch ms)
   */
  getLastDreamCycleTime(): number {
    const row = this.db.query<{ completed_at: number }, []>(
      `SELECT completed_at FROM dream_cycle_runs
       WHERE status = 'completed'
       ORDER BY completed_at DESC
       LIMIT 1`
    ).get();
    return row?.completed_at ?? 0;
  }

  /**
   * Get the last dream cycle run report
   */
  getLastRun(): DreamCycleRunRow | null {
    return this.db.query<DreamCycleRunRow, []>(
      `SELECT * FROM dream_cycle_runs
       ORDER BY id DESC
       LIMIT 1`
    ).get() ?? null;
  }

  /**
   * Record dream cycle start in the database
   */
  private recordStart(): number {
    const result = this.db.query(
      `INSERT INTO dream_cycle_runs (started_at, status, observations_processed)
       VALUES (?, 'running', 0)`
    ).run(Date.now());
    return Number(result.lastInsertRowid);
  }

  /**
   * Record dream cycle completion
   */
  private recordComplete(runId: number, report: DreamCycleReport): void {
    this.db.query(
      `UPDATE dream_cycle_runs
       SET completed_at = ?, status = ?, report = ?, observations_processed = ?
       WHERE id = ?`
    ).run(
      Date.now(),
      report.status,
      JSON.stringify(report),
      report.phases.cluster?.observationsProcessed ?? 0,
      runId
    );
  }

  /**
   * Run the full dream cycle — all 4 phases
   */
  async run(): Promise<DreamCycleReport> {
    if (this.running) {
      throw new Error('Dream cycle is already running');
    }

    this.running = true;
    const report: DreamCycleReport = {
      startedAt: Date.now(),
      status: 'running',
      phases: {},
    };

    const runId = this.recordStart();

    try {
      // Determine observation window
      const lastCycleTime = this.getLastDreamCycleTime();
      const sinceEpoch = lastCycleTime || 0; // 0 = process all observations on first run

      // Phase 1: Clustering
      logger.info('DREAM', '=== Phase 1: Observation Clustering ===');
      const observations = this.getObservationsSince(sinceEpoch);
      const clusters = clusterObservations(observations);
      report.phases.cluster = {
        observationsProcessed: observations.length,
        clustersFound: clusters.length,
      };
      logger.info('DREAM', `Phase 1 complete: ${observations.length} observations → ${clusters.length} clusters`);

      // Phase 2: Compilation (LLM)
      if (clusters.length > 0) {
        logger.info('DREAM', '=== Phase 2: Compiled Summary Generation ===');
        report.phases.compile = await compileClusters(clusters, this.compiledStore);
        logger.info('DREAM', `Phase 2 complete: ${report.phases.compile.created} created, ${report.phases.compile.updated} updated, ${report.phases.compile.skipped} skipped`);
      } else {
        report.phases.compile = { created: 0, updated: 0, skipped: 0, errors: [] };
        logger.info('DREAM', 'Phase 2 skipped: no clusters to compile');
      }

      // Phase 3: Cleanup
      logger.info('DREAM', '=== Phase 3: Stale Observation Cleanup ===');
      report.phases.cleanup = runCleanup(this.db);
      logger.info('DREAM', `Phase 3 complete: ${report.phases.cleanup.merged} merged, ${report.phases.cleanup.demoted} demoted, ${report.phases.cleanup.flagged} flagged`);

      // Phase 4: Index Refresh
      logger.info('DREAM', '=== Phase 4: Index Refresh ===');
      report.phases.refresh = await runRefresh(this.db);
      logger.info('DREAM', `Phase 4 complete: FTS5=${report.phases.refresh.fts5Rebuilt}, ChromaDB=${report.phases.refresh.compiledSummariesIndexed}`);

      // Success
      report.status = 'completed';
      report.completedAt = Date.now();
      const durationSec = ((report.completedAt - report.startedAt) / 1000).toFixed(1);
      logger.success('DREAM', `Dream cycle completed in ${durationSec}s`);
    } catch (error) {
      report.status = 'failed';
      report.error = error instanceof Error ? error.message : String(error);
      report.completedAt = Date.now();
      logger.error('DREAM', 'Dream cycle failed', {}, error as Error);
    } finally {
      this.running = false;
      this.recordComplete(runId, report);
    }

    return report;
  }
}
