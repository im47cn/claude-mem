/**
 * Threshold-based Compilation Trigger
 *
 * Monitors observation count and triggers incremental compilation when
 * enough uncompiled observations accumulate. Uses debouncing to avoid
 * running on every single observation insert.
 *
 * Design:
 * - Debounced: waits DEBOUNCE_MS after last notification before checking
 * - Incremental: only processes observations since last compilation
 * - Lightweight: reuses Phase 1 clustering + Phase 2 compilation
 * - Non-blocking: runs async, errors are logged but never thrown
 */

import { Database } from 'bun:sqlite';
import type { ObservationForClustering } from './types.js';
import { clusterObservations } from './clustering.js';
import { compileClusters } from './compiler.js';
import { CompiledSummaryStore } from '../search/compiled-summaries.js';
import { logger } from '../../../utils/logger.js';

/** Minimum observations in a cluster to trigger compilation */
const DEFAULT_THRESHOLD = 5;

/** Debounce delay in milliseconds */
const DEFAULT_DEBOUNCE_MS = 30_000; // 30 seconds

export interface ThresholdTriggerOptions {
  /** Minimum cluster size to trigger compilation (default: 5) */
  threshold?: number;
  /** Debounce delay in ms after last notify (default: 30000) */
  debounceMs?: number;
}

export class ThresholdTrigger {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private compiledStore: CompiledSummaryStore;
  private threshold: number;
  private debounceMs: number;
  /** Epoch ms of the last successful threshold compilation */
  private lastCompilationEpoch = 0;

  constructor(
    private db: Database,
    options: ThresholdTriggerOptions = {}
  ) {
    this.compiledStore = new CompiledSummaryStore(db);
    this.threshold = options.threshold ?? DEFAULT_THRESHOLD;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  /**
   * Notify the trigger that new observations have been stored.
   * Debounces: resets the timer on each call, only runs check
   * after debounceMs of quiet.
   */
  notify(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.checkAndCompile().catch(err => {
        logger.warn('THRESHOLD', `Threshold check failed: ${(err as Error).message}`);
      });
    }, this.debounceMs);
  }

  /**
   * Check for uncompiled observation clusters and compile if threshold met.
   * Can also be called directly (bypasses debounce) for testing.
   */
  async checkAndCompile(): Promise<{ compiled: number; skipped: number }> {
    if (this.running) {
      return { compiled: 0, skipped: 0 };
    }

    this.running = true;
    try {
      // Query observations since last threshold compilation
      const observations = this.getRecentObservations();

      if (observations.length < this.threshold) {
        return { compiled: 0, skipped: observations.length };
      }

      // Phase 1: Cluster with threshold as min cluster size
      const clusters = clusterObservations(observations, {
        minClusterSize: this.threshold,
      });

      if (clusters.length === 0) {
        return { compiled: 0, skipped: observations.length };
      }

      logger.info('THRESHOLD', `Found ${clusters.length} clusters meeting threshold (${this.threshold}+ observations)`);

      // Phase 2: Compile qualifying clusters
      const result = await compileClusters(clusters, this.compiledStore);

      const compiled = result.created + result.updated;
      if (compiled > 0) {
        this.lastCompilationEpoch = Date.now();
        logger.info('THRESHOLD', `Compiled ${compiled} summaries (${result.created} new, ${result.updated} updated)`);
      }

      return { compiled, skipped: result.skipped };
    } finally {
      this.running = false;
    }
  }

  /**
   * Get observations since last threshold compilation that haven't been
   * included in any compiled summary yet.
   */
  private getRecentObservations(): ObservationForClustering[] {
    return this.db.query<ObservationForClustering, [number]>(
      `SELECT o.id, o.memory_session_id, o.project, o.title, o.subtitle,
              o.narrative, o.facts, o.concepts, o.type, o.created_at_epoch
       FROM observations o
       WHERE o.created_at_epoch > ?
         AND o.demoted = 0
       ORDER BY o.created_at_epoch ASC`
    ).all(this.lastCompilationEpoch);
  }

  /**
   * Cancel any pending debounced check.
   */
  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Check if a compilation check is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }
}
