import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { compileClusters } from '../../../src/services/worker/dream/compiler.js';
import { CompiledSummaryStore } from '../../../src/services/worker/search/compiled-summaries.js';
import type { ObservationCluster } from '../../../src/services/worker/dream/types.js';
import type { LLMProvider } from '../../../src/services/worker/search/synthesizer-providers.js';

/**
 * Helper: create compiled_summaries table for in-memory test DB
 */
function createCompiledSummariesTable(db: Database): void {
  db.exec(`
    CREATE TABLE compiled_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      compiled_text TEXT NOT NULL,
      confidence REAL DEFAULT 0.8,
      observation_ids TEXT NOT NULL,
      observation_count INTEGER DEFAULT 0,
      project TEXT,
      is_stale INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_compiled_topic ON compiled_summaries(topic);
    CREATE INDEX idx_compiled_type ON compiled_summaries(entity_type);
    CREATE INDEX idx_compiled_project ON compiled_summaries(project);
    CREATE INDEX idx_compiled_updated ON compiled_summaries(updated_at);
    CREATE INDEX idx_compiled_stale ON compiled_summaries(is_stale);
  `);
}

/**
 * Mock LLM provider for testing
 */
class MockLLMProvider implements LLMProvider {
  name = 'mock';
  calls: Array<{ system: string; user: string }> = [];
  response: string | null = 'Synthesized summary for testing.';

  async complete(system: string, user: string): Promise<string | null> {
    this.calls.push({ system, user });
    return this.response;
  }
}

function makeCluster(overrides: Partial<ObservationCluster> = {}): ObservationCluster {
  return {
    topic: overrides.topic ?? 'test/topic',
    entityType: overrides.entityType ?? 'preference',
    project: overrides.project ?? 'test-project',
    observations: overrides.observations ?? [
      {
        id: 1,
        memory_session_id: 'sess-1',
        project: 'test-project',
        title: 'Test observation',
        subtitle: null,
        narrative: 'User prefers Bun runtime.',
        facts: '["prefers Bun"]',
        concepts: '["runtime"]',
        type: 'discovery',
        created_at_epoch: Date.now(),
      },
      {
        id: 2,
        memory_session_id: 'sess-1',
        project: 'test-project',
        title: 'Another observation',
        subtitle: null,
        narrative: 'Bun adopted in 3 projects.',
        facts: '["adopted Bun"]',
        concepts: '["runtime"]',
        type: 'change',
        created_at_epoch: Date.now(),
      },
    ],
    keywords: overrides.keywords ?? ['bun', 'runtime'],
  };
}

describe('compileClusters', () => {
  let db: Database;
  let store: CompiledSummaryStore;
  let mockLLM: MockLLMProvider;

  beforeEach(() => {
    db = new Database(':memory:');
    createCompiledSummariesTable(db);
    store = new CompiledSummaryStore(db);
    mockLLM = new MockLLMProvider();
  });

  afterEach(() => {
    db.close();
  });

  it('creates new compiled summaries from clusters', async () => {
    const clusters = [makeCluster({ topic: 'runtime/bun' })];

    const result = await compileClusters(clusters, store, mockLLM);

    expect(result.created).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);

    // Verify stored in DB
    const stored = store.findByTopic('runtime/bun');
    expect(stored).toHaveLength(1);
    expect(stored[0].compiled_text).toBe('Synthesized summary for testing.');
  });

  it('updates existing summaries (REWRITE mode)', async () => {
    // Pre-populate an existing summary
    store.upsert({
      topic: 'runtime/bun',
      entity_type: 'preference',
      compiled_text: 'Old summary.',
      observation_ids: [1],
      project: 'test-project',
    });

    const clusters = [makeCluster({ topic: 'runtime/bun' })];

    const result = await compileClusters(clusters, store, mockLLM);

    expect(result.updated).toBe(1);
    expect(result.created).toBe(0);

    // Verify REWRITTEN (not appended)
    const stored = store.findByTopic('runtime/bun');
    expect(stored).toHaveLength(1);
    expect(stored[0].compiled_text).toBe('Synthesized summary for testing.');
  });

  it('tracks skipped clusters when LLM fails', async () => {
    mockLLM.response = null; // Simulate LLM failure

    const clusters = [makeCluster(), makeCluster({ topic: 'other/topic' })];

    const result = await compileClusters(clusters, store, mockLLM);

    expect(result.skipped).toBe(2);
    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
  });

  it('returns all skipped when no LLM provider configured', async () => {
    const clusters = [makeCluster(), makeCluster({ topic: 'other/topic' })];

    // Pass null explicitly to simulate no provider
    const result = await compileClusters(clusters, store, null);

    expect(result.skipped).toBe(2);
    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
  });

  it('handles empty clusters array', async () => {
    const result = await compileClusters([], store, mockLLM);

    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('reports mix of created and updated correctly', async () => {
    // Pre-populate one existing summary
    store.upsert({
      topic: 'existing/topic',
      entity_type: 'pattern',
      compiled_text: 'Old pattern summary.',
      observation_ids: [10],
    });

    const clusters = [
      makeCluster({ topic: 'existing/topic', entityType: 'pattern' }),
      makeCluster({ topic: 'new/topic' }),
    ];

    const result = await compileClusters(clusters, store, mockLLM);

    expect(result.created).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
  });
});
