import { describe, it, expect, beforeEach } from 'bun:test';
import { Synthesizer } from '../../../src/services/worker/search/synthesizer.js';
import type { LLMProvider } from '../../../src/services/worker/search/synthesizer-providers.js';
import type { ObservationForClustering, ObservationCluster } from '../../../src/services/worker/dream/types.js';

/**
 * Mock LLM provider for testing without real API calls
 */
class MockLLMProvider implements LLMProvider {
  readonly name = 'mock';
  calls: { system: string; user: string }[] = [];
  response: string | null = 'User strongly prefers Bun runtime. Adopted across 3 projects.';

  async complete(systemPrompt: string, userPrompt: string): Promise<string | null> {
    this.calls.push({ system: systemPrompt, user: userPrompt });
    return this.response;
  }
}

function makeObs(overrides: Partial<ObservationForClustering> = {}): ObservationForClustering {
  return {
    id: 1,
    memory_session_id: 'sess-1',
    project: 'test-project',
    title: 'Test Observation',
    subtitle: null,
    narrative: 'Some narrative',
    facts: '["fact1"]',
    concepts: '["concept1"]',
    type: 'discovery',
    created_at_epoch: Date.now(),
    ...overrides,
  };
}

function makeCluster(overrides: Partial<ObservationCluster> = {}): ObservationCluster {
  return {
    topic: 'user-preferences/runtime',
    entityType: 'preference',
    project: 'test-project',
    observations: [
      makeObs({ id: 1, title: 'Bun runtime used' }),
      makeObs({ id: 2, title: 'Bun preferred over Node' }),
      makeObs({ id: 3, title: 'Migrated to Bun' }),
    ],
    keywords: ['bun', 'runtime', 'node'],
    ...overrides,
  };
}

describe('Synthesizer', () => {
  let mockLLM: MockLLMProvider;
  let synthesizer: Synthesizer;

  beforeEach(() => {
    mockLLM = new MockLLMProvider();
    synthesizer = new Synthesizer(mockLLM);
  });

  describe('synthesize', () => {
    it('generates compiled summary from observation cluster', async () => {
      const result = await synthesizer.synthesize(makeCluster());

      expect(result).not.toBeNull();
      expect(result!.compiled_text).toBe('User strongly prefers Bun runtime. Adopted across 3 projects.');
      expect(result!.topic).toBe('user-preferences/runtime');
      expect(result!.entity_type).toBe('preference');
      expect(result!.project).toBe('test-project');
    });

    it('preserves observation IDs for traceability', async () => {
      const result = await synthesizer.synthesize(makeCluster());

      expect(result).not.toBeNull();
      expect(result!.observation_ids).toEqual([1, 2, 3]);
    });

    it('calculates confidence from observation count', async () => {
      // 3 observations: min(0.5 + 3 * 0.1, 1.0) = 0.8
      const result = await synthesizer.synthesize(makeCluster());
      expect(result!.confidence).toBe(0.8);
    });

    it('caps confidence at 1.0 for large clusters', async () => {
      const bigCluster = makeCluster({
        observations: Array.from({ length: 10 }, (_, i) =>
          makeObs({ id: i + 1 })
        ),
      });
      // 10 observations: min(0.5 + 10 * 0.1, 1.0) = 1.0
      const result = await synthesizer.synthesize(bigCluster);
      expect(result!.confidence).toBe(1.0);
    });

    it('returns null on LLM failure', async () => {
      mockLLM.response = null;
      const result = await synthesizer.synthesize(makeCluster());
      expect(result).toBeNull();
    });

    it('returns null on empty LLM response', async () => {
      mockLLM.response = '';
      const result = await synthesizer.synthesize(makeCluster());
      expect(result).toBeNull();
    });

    it('includes existing summary in REWRITE prompt', async () => {
      const cluster = makeCluster();
      const existing = {
        id: 99,
        topic: 'user-preferences/runtime',
        entity_type: 'preference' as const,
        compiled_text: 'Old summary about Bun.',
        confidence: 0.6,
        observation_ids: '[1]',
        project: 'test-project',
        created_at: Date.now(),
        updated_at: Date.now(),
      };

      await synthesizer.synthesize(cluster, existing);

      expect(mockLLM.calls).toHaveLength(1);
      expect(mockLLM.calls[0].user).toContain('Old summary about Bun.');
    });

    it('handles cluster with null project (global)', async () => {
      const globalCluster = makeCluster({ project: null });
      const result = await synthesizer.synthesize(globalCluster);

      expect(result).not.toBeNull();
      expect(result!.project).toBeUndefined();
    });

    it('calls LLM exactly once per synthesize call', async () => {
      await synthesizer.synthesize(makeCluster());
      expect(mockLLM.calls).toHaveLength(1);
    });
  });

  describe('synthesizeBatch', () => {
    it('processes multiple clusters sequentially', async () => {
      const clusters = [
        makeCluster({ topic: 'topic/a' }),
        makeCluster({ topic: 'topic/b' }),
        makeCluster({ topic: 'topic/c' }),
      ];

      const results = await synthesizer.synthesizeBatch(clusters);
      expect(results).toHaveLength(3);
      expect(mockLLM.calls).toHaveLength(3);
    });

    it('skips failed clusters and continues', async () => {
      let callCount = 0;
      mockLLM.complete = async () => {
        callCount++;
        if (callCount === 2) return null; // Second call fails
        return 'Valid summary.';
      };

      const clusters = [
        makeCluster({ topic: 'topic/a' }),
        makeCluster({ topic: 'topic/b' }),
        makeCluster({ topic: 'topic/c' }),
      ];

      const results = await synthesizer.synthesizeBatch(clusters);
      expect(results).toHaveLength(2); // 2 of 3 succeeded
    });

    it('calls onProgress callback', async () => {
      const progress: [number, number][] = [];

      const clusters = [
        makeCluster({ topic: 'topic/a' }),
        makeCluster({ topic: 'topic/b' }),
      ];

      await synthesizer.synthesizeBatch(clusters, {
        onProgress: (completed, total) => progress.push([completed, total]),
      });

      expect(progress).toEqual([[1, 2], [2, 2]]);
    });

    it('returns empty array for empty input', async () => {
      const results = await synthesizer.synthesizeBatch([]);
      expect(results).toEqual([]);
      expect(mockLLM.calls).toHaveLength(0);
    });
  });
});
