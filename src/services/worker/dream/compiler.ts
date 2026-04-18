/**
 * Dream Cycle Phase 2: Compiled Summary Generation
 *
 * Bridges the Synthesizer component into the Dream Cycle pipeline.
 * Takes observation clusters from Phase 1 and produces compiled summaries
 * via the Synthesizer's LLM abstraction.
 *
 * Design:
 * - Creates an LLM provider from user settings
 * - Instantiates a Synthesizer with that provider
 * - Looks up existing compiled summaries for REWRITE mode
 * - Runs synthesizeBatch, then upserts results into CompiledSummaryStore
 * - Returns CompileResult with created/updated/skipped/errors counts
 */

import type { ObservationCluster, CompileResult } from './types.js';
import { CompiledSummaryStore } from '../search/compiled-summaries.js';
import { Synthesizer } from '../search/synthesizer.js';
import { createLLMProvider } from '../search/synthesizer-providers.js';
import type { LLMProvider } from '../search/synthesizer-providers.js';
import type { CompiledSummaryRow } from '../search/types.js';
import { logger } from '../../../utils/logger.js';

/**
 * Compile observation clusters into synthesized summaries.
 *
 * Called by DreamCycleRunner.run() as Phase 2.
 * Graceful degradation: if no LLM provider is configured, skips all clusters.
 *
 * @param clusters - Observation clusters from Phase 1
 * @param store - CompiledSummaryStore for persistence
 * @param injectedLLM - Optional LLM provider for testing (defaults to createLLMProvider())
 */
export async function compileClusters(
  clusters: ObservationCluster[],
  store: CompiledSummaryStore,
  injectedLLM?: LLMProvider | null
): Promise<CompileResult> {
  const result: CompileResult = {
    created: 0,
    updated: 0,
    skipped: 0,
    errors: [],
  };

  // Use injected provider or create from user settings
  const llm = injectedLLM !== undefined ? injectedLLM : createLLMProvider();
  if (!llm) {
    logger.info('DREAM', 'No LLM provider configured — skipping Phase 2 compilation');
    result.skipped = clusters.length;
    return result;
  }

  const synthesizer = new Synthesizer(llm);

  // Build existing summaries map for REWRITE detection
  const existingByTopic = new Map<string, CompiledSummaryRow>();
  for (const cluster of clusters) {
    const existing = store.findByTopic(cluster.topic);
    if (existing.length > 0) {
      existingByTopic.set(cluster.topic, existing[0]);
    }
  }

  logger.info('DREAM', `Compiling ${clusters.length} clusters (${existingByTopic.size} existing for REWRITE)`, {
    provider: llm.name,
  });

  // Synthesize all clusters
  const synthResults = await synthesizer.synthesizeBatch(clusters, {
    existingByTopic,
    onProgress: (completed, total) => {
      if (completed % 5 === 0 || completed === total) {
        logger.debug('DREAM', `Compilation progress: ${completed}/${total}`);
      }
    },
  });

  // Upsert successful results into the store
  for (const synthResult of synthResults) {
    try {
      const isUpdate = existingByTopic.has(synthResult.topic);
      store.upsert({
        topic: synthResult.topic,
        entity_type: synthResult.entity_type,
        compiled_text: synthResult.compiled_text,
        confidence: synthResult.confidence,
        observation_ids: synthResult.observation_ids,
        project: synthResult.project,
      });

      if (isUpdate) {
        result.updated++;
      } else {
        result.created++;
      }
    } catch (error) {
      const msg = `Failed to upsert compiled summary for ${synthResult.topic}: ${(error as Error).message}`;
      logger.warn('DREAM', msg);
      result.errors.push(msg);
    }
  }

  // Clusters that failed synthesis = skipped
  result.skipped = clusters.length - synthResults.length;

  return result;
}
