/**
 * Dream Cycle Types - Shared interfaces for the self-managed dream cycle
 *
 * The dream cycle periodically consolidates observations into compiled summaries,
 * cleans up stale data, and refreshes search indexes.
 */

export interface ObservationForClustering {
  id: number;
  memory_session_id: string;
  project: string;
  title: string | null;
  subtitle: string | null;
  narrative: string | null;
  facts: string | null;
  concepts: string | null;
  type: string;
  created_at_epoch: number;
}

export interface ObservationCluster {
  /** Derived topic key, e.g. "user-preferences/runtime" */
  topic: string;
  /** Entity type for the compiled summary */
  entityType: 'preference' | 'pattern' | 'decision' | 'project' | 'tool';
  /** Project scope (null for cross-project clusters) */
  project: string | null;
  /** Observations in this cluster */
  observations: ObservationForClustering[];
  /** Representative keywords for this cluster */
  keywords: string[];
}

export interface ClusterOptions {
  /** Minimum Jaccard similarity for keyword overlap (default: 0.3) */
  minSimilarity?: number;
  /** Minimum cluster size to keep (default: 3) */
  minClusterSize?: number;
}

export interface CompileResult {
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
}

export interface CleanupReport {
  merged: number;
  demoted: number;
  flagged: number;
}

export interface RefreshReport {
  fts5Rebuilt: boolean;
  compiledSummariesIndexed: number;
}

export interface DreamCycleReport {
  startedAt: number;
  completedAt?: number;
  status: 'running' | 'completed' | 'failed';
  phases: {
    cluster?: { observationsProcessed: number; clustersFound: number };
    compile?: CompileResult;
    cleanup?: CleanupReport;
    refresh?: RefreshReport;
  };
  error?: string;
}

export interface DreamCycleRunRow {
  id: number;
  started_at: number;
  completed_at: number | null;
  status: string;
  report: string | null;
  observations_processed: number;
}
