/**
 * Compiled Summaries module - public API
 *
 * Implements the Compiled Truth Synthesis Layer from GBrain.
 * Provides a rewritable synthesis layer above the append-only observations timeline.
 */

export {
  createCompiledSummary,
  rewriteCompiledSummary,
  markStale,
  markStaleById,
  deleteCompiledSummary
} from './store.js';

export {
  getCompiledSummaryById,
  getCompiledSummaryByTopic,
  searchCompiledSummaries,
  getStaleCompiledSummaries,
  getCompiledSummariesForProject,
  countCompiledSummaries,
  getLinkedObservationIds
} from './get.js';

export {
  clusterObservations,
  compileAll,
  buildSynthesisPrompt,
  localSynthesize
} from './compiler.js';

export type {
  CompilationResult,
  ObservationCluster,
  SynthesisFunction
} from './compiler.js';
