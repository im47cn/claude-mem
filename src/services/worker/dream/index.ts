/**
 * Dream Cycle Module
 *
 * Self-managed dream cycle for knowledge consolidation.
 * 4 phases: Clustering → Compilation → Cleanup → Refresh
 */

export { DreamCycleRunner } from './DreamCycleRunner.js';
export { clusterObservations, clusterByKeywordOverlap, extractKeywords, keywordSimilarity } from './clustering.js';
export { compileClusters } from './compiler.js';
export { runCleanup } from './cleanup.js';
export { runRefresh } from './refresh.js';
export { ThresholdTrigger } from './threshold-trigger.js';
export type { ThresholdTriggerOptions } from './threshold-trigger.js';
export type {
  ObservationForClustering,
  ObservationCluster,
  ClusterOptions,
  CompileResult,
  CleanupReport,
  RefreshReport,
  DreamCycleReport,
  DreamCycleRunRow,
} from './types.js';
