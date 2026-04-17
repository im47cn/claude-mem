import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { CompiledSummaryStore } from '../../../src/services/worker/search/compiled-summaries.js';

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
      project TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_compiled_topic ON compiled_summaries(topic);
    CREATE INDEX idx_compiled_type ON compiled_summaries(entity_type);
    CREATE INDEX idx_compiled_project ON compiled_summaries(project);
    CREATE INDEX idx_compiled_updated ON compiled_summaries(updated_at);
  `);
}

describe('CompiledSummaryStore', () => {
  let db: Database;
  let store: CompiledSummaryStore;

  beforeEach(() => {
    db = new Database(':memory:');
    createCompiledSummariesTable(db);
    store = new CompiledSummaryStore(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('upsert', () => {
    it('creates a new compiled summary', () => {
      const id = store.upsert({
        topic: 'user-preferences/runtime',
        entity_type: 'preference',
        compiled_text: 'User prefers Bun runtime over Node.js.',
        observation_ids: [1, 2, 3],
        project: 'test-project',
      });

      expect(id).toBeGreaterThan(0);

      const summary = store.getById(id);
      expect(summary).not.toBeNull();
      expect(summary!.topic).toBe('user-preferences/runtime');
      expect(summary!.compiled_text).toBe('User prefers Bun runtime over Node.js.');
      expect(JSON.parse(summary!.observation_ids)).toEqual([1, 2, 3]);
    });

    it('updates existing summary by topic (REWRITE, not append)', () => {
      store.upsert({
        topic: 'user-preferences/runtime',
        entity_type: 'preference',
        compiled_text: 'User prefers Bun.',
        observation_ids: [1],
      });

      store.upsert({
        topic: 'user-preferences/runtime',
        entity_type: 'preference',
        compiled_text: 'User strongly prefers Bun. Adopted in 3 projects.',
        observation_ids: [1, 2, 3],
      });

      const all = store.findByTopic('user-preferences/runtime');
      expect(all).toHaveLength(1);
      expect(all[0].compiled_text).toBe('User strongly prefers Bun. Adopted in 3 projects.');
      expect(JSON.parse(all[0].observation_ids)).toEqual([1, 2, 3]);
    });

    it('auto-calculates confidence from observation count', () => {
      const id = store.upsert({
        topic: 'test/confidence',
        entity_type: 'pattern',
        compiled_text: 'Test confidence calculation.',
        observation_ids: [1, 2, 3, 4, 5],
      });

      const summary = store.getById(id);
      // confidence = min(0.5 + 5 * 0.1, 1.0) = 1.0
      expect(summary!.confidence).toBe(1.0);
    });

    it('uses explicit confidence when provided', () => {
      const id = store.upsert({
        topic: 'test/explicit-conf',
        entity_type: 'decision',
        compiled_text: 'Explicit confidence.',
        observation_ids: [1],
        confidence: 0.95,
      });

      const summary = store.getById(id);
      expect(summary!.confidence).toBe(0.95);
    });
  });

  describe('search', () => {
    beforeEach(() => {
      store.upsert({
        topic: 'user-preferences/runtime',
        entity_type: 'preference',
        compiled_text: 'User prefers Bun runtime. Adopted across 3 projects.',
        observation_ids: [1, 2, 3],
        project: 'project-a',
      });
      store.upsert({
        topic: 'architecture/caching',
        entity_type: 'pattern',
        compiled_text: 'Redis caching layer with 5-minute TTL.',
        observation_ids: [4, 5],
        project: 'project-b',
      });
      store.upsert({
        topic: 'decisions/database',
        entity_type: 'decision',
        compiled_text: 'Chose PostgreSQL over MongoDB for ACID compliance.',
        observation_ids: [6, 7, 8],
      });
    });

    it('finds by topic substring', () => {
      const results = store.searchByText('runtime');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].topic).toContain('runtime');
    });

    it('finds by compiled_text content', () => {
      const results = store.searchByText('Redis caching');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].topic).toBe('architecture/caching');
    });

    it('filters by project', () => {
      const results = store.searchByText('', { project: 'project-a' });
      expect(results.every(r => r.project === 'project-a')).toBe(true);
    });

    it('filters by entity_type', () => {
      const results = store.searchByText('', { entityType: 'decision' });
      expect(results.every(r => r.entity_type === 'decision')).toBe(true);
    });

    it('includes observation_count', () => {
      const results = store.searchByText('runtime');
      expect(results[0].observation_count).toBe(3);
    });

    it('returns empty array for no match', () => {
      const results = store.searchByText('nonexistent-query-xyz');
      expect(results).toHaveLength(0);
    });
  });

  describe('getById', () => {
    it('returns null for non-existent id', () => {
      expect(store.getById(999)).toBeNull();
    });
  });

  describe('getByProject', () => {
    it('returns summaries scoped to project', () => {
      store.upsert({
        topic: 'test/scoped',
        entity_type: 'tool',
        compiled_text: 'Project-scoped summary.',
        observation_ids: [10],
        project: 'my-project',
      });
      store.upsert({
        topic: 'test/other',
        entity_type: 'tool',
        compiled_text: 'Other project summary.',
        observation_ids: [11],
        project: 'other-project',
      });

      const results = store.getByProject('my-project');
      expect(results).toHaveLength(1);
      expect(results[0].topic).toBe('test/scoped');
    });
  });

  describe('getGlobal', () => {
    it('returns summaries without project scope', () => {
      store.upsert({
        topic: 'global/pattern',
        entity_type: 'pattern',
        compiled_text: 'A global pattern.',
        observation_ids: [20],
      });
      store.upsert({
        topic: 'scoped/pattern',
        entity_type: 'pattern',
        compiled_text: 'A scoped pattern.',
        observation_ids: [21],
        project: 'some-project',
      });

      const results = store.getGlobal();
      expect(results.every(r => r.project === null)).toBe(true);
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('filters by entity types', () => {
      store.upsert({
        topic: 'global/decision',
        entity_type: 'decision',
        compiled_text: 'A decision.',
        observation_ids: [30],
      });
      store.upsert({
        topic: 'global/tool',
        entity_type: 'tool',
        compiled_text: 'A tool note.',
        observation_ids: [31],
      });

      const results = store.getGlobal(['decision']);
      expect(results.every(r => r.entity_type === 'decision')).toBe(true);
    });
  });

  describe('delete', () => {
    it('deletes an existing summary', () => {
      const id = store.upsert({
        topic: 'to-delete',
        entity_type: 'tool',
        compiled_text: 'Will be deleted.',
        observation_ids: [40],
      });

      expect(store.delete(id)).toBe(true);
      expect(store.getById(id)).toBeNull();
    });

    it('returns false for non-existent id', () => {
      expect(store.delete(999)).toBe(false);
    });
  });

  describe('count', () => {
    it('returns correct count', () => {
      expect(store.count()).toBe(0);

      store.upsert({
        topic: 'count/test1',
        entity_type: 'preference',
        compiled_text: 'First.',
        observation_ids: [50],
      });
      store.upsert({
        topic: 'count/test2',
        entity_type: 'pattern',
        compiled_text: 'Second.',
        observation_ids: [51],
      });

      expect(store.count()).toBe(2);
    });
  });
});
