/**
 * Synthesizer - Core component for Compiled Truth pattern (Spec 001)
 *
 * Takes a cluster of related observations and produces a synthesized
 * summary via LLM. Independent component, callable by Dream Cycle,
 * API endpoints, or manual triggers.
 *
 * Design:
 * - Input: ObservationCluster (from Dream Cycle Phase 1 or other clustering)
 * - Output: SynthesizerResult (ready for CompiledSummaryStore.upsert())
 * - LLM: Injected LLMProvider abstraction
 * - Errors: Returns null on failure (graceful degradation)
 */

import type { LLMProvider } from './synthesizer-providers.js';
import type { ObservationCluster } from '../../worker/dream/types.js';
import type { CompiledSummaryRow, SynthesizerResult } from './types.js';
import { buildSystemPrompt, buildUserPrompt } from './synthesizer-prompts.js';
import { logger } from '../../../utils/logger.js';

export class Synthesizer {
  constructor(private llm: LLMProvider) {}

  /**
   * Synthesize a single cluster into a compiled summary.
   * Returns null on LLM failure (graceful degradation).
   */
  async synthesize(
    cluster: ObservationCluster,
    existing?: CompiledSummaryRow
  ): Promise<SynthesizerResult | null> {
    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt({
      topic: cluster.topic,
      entityType: cluster.entityType,
      observations: cluster.observations,
      project: cluster.project ?? undefined,
      existingText: existing?.compiled_text,
    });

    logger.debug('SYNTH', `Synthesizing cluster: ${cluster.topic}`, {
      observationCount: cluster.observations.length,
      mode: existing ? 'rewrite' : 'create',
      provider: this.llm.name,
    });

    const compiledText = await this.llm.complete(systemPrompt, userPrompt);

    if (!compiledText || compiledText.trim().length === 0) {
      logger.warn('SYNTH', `LLM returned empty response for: ${cluster.topic}`, {});
      return null;
    }

    const observationIds = cluster.observations.map(o => o.id);
    const confidence = Math.min(0.5 + observationIds.length * 0.1, 1.0);

    return {
      compiled_text: compiledText.trim(),
      confidence,
      observation_ids: observationIds,
      topic: cluster.topic,
      entity_type: cluster.entityType,
      project: cluster.project ?? undefined,
    };
  }

  /**
   * Batch-synthesize multiple clusters sequentially.
   * Skips failed clusters, returns successful results only.
   */
  async synthesizeBatch(
    clusters: ObservationCluster[],
    opts?: {
      onProgress?: (completed: number, total: number) => void;
      existingByTopic?: Map<string, CompiledSummaryRow>;
    }
  ): Promise<SynthesizerResult[]> {
    const results: SynthesizerResult[] = [];

    for (let i = 0; i < clusters.length; i++) {
      const cluster = clusters[i];
      const existing = opts?.existingByTopic?.get(cluster.topic);

      try {
        const result = await this.synthesize(cluster, existing);
        if (result) {
          results.push(result);
        }
      } catch (error) {
        logger.warn('SYNTH', `Failed to synthesize cluster: ${cluster.topic}`, {
          error: (error as Error).message,
        });
      }

      opts?.onProgress?.(i + 1, clusters.length);
    }

    return results;
  }
}
