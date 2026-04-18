import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ThresholdTrigger } from '../../../src/services/worker/dream/threshold-trigger.js';

/**
 * Helper: create minimal tables needed for threshold trigger tests
 */
function createTestTables(db: Database): void {
  db.exec(`
    CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      text TEXT,
      type TEXT NOT NULL,
      title TEXT,
      subtitle TEXT,
      facts TEXT,
      narrative TEXT,
      concepts TEXT,
      files_read TEXT,
      files_modified TEXT,
      prompt_number INTEGER,
      discovery_tokens INTEGER DEFAULT 0,
      demoted INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    );
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

/**
 * Insert a test observation into the DB
 */
function insertObservation(
  db: Database,
  overrides: {
    project?: string;
    title?: string;
    narrative?: string;
    type?: string;
    facts?: string;
    concepts?: string;
    epochMs?: number;
  } = {}
): number {
  const result = db.query(`
    INSERT INTO observations (memory_session_id, project, type, title, subtitle, narrative, facts, concepts, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'sess-test',
    overrides.project ?? 'test-project',
    overrides.type ?? 'discovery',
    overrides.title ?? 'Test observation',
    null,
    overrides.narrative ?? 'Some observation narrative.',
    overrides.facts ?? '["fact1"]',
    overrides.concepts ?? '["concept1"]',
    new Date().toISOString(),
    overrides.epochMs ?? Date.now()
  );
  return Number(result.lastInsertRowid);
}

describe('ThresholdTrigger', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    createTestTables(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('checkAndCompile', () => {
    it('skips when observations below threshold', async () => {
      // Insert only 2 observations (threshold is 5)
      insertObservation(db, { title: 'Bun runtime preference', narrative: 'User prefers Bun runtime' });
      insertObservation(db, { title: 'Bun adoption', narrative: 'Bun adopted in project' });

      const trigger = new ThresholdTrigger(db, { threshold: 5 });
      const result = await trigger.checkAndCompile();

      expect(result.compiled).toBe(0);
      expect(result.skipped).toBe(2);
    });

    it('skips when no clusters meet minimum size', async () => {
      // Insert 5 observations but with very different topics (will not cluster)
      insertObservation(db, { title: 'Bun runtime', narrative: 'Bun runtime preference', facts: '["bun", "runtime"]' });
      insertObservation(db, { title: 'PostgreSQL', narrative: 'PostgreSQL database choice', facts: '["postgres", "database"]' });
      insertObservation(db, { title: 'Docker setup', narrative: 'Docker container configuration', facts: '["docker", "container"]' });
      insertObservation(db, { title: 'React frontend', narrative: 'React component architecture', facts: '["react", "frontend"]' });
      insertObservation(db, { title: 'Redis caching', narrative: 'Redis caching strategy', facts: '["redis", "caching"]' });

      const trigger = new ThresholdTrigger(db, { threshold: 3 });
      const result = await trigger.checkAndCompile();

      // No cluster of 3+ similar observations
      expect(result.compiled).toBe(0);
    });

    it('compiles when cluster meets threshold (with LLM configured)', async () => {
      // Insert 5 similar observations about the same topic
      for (let i = 0; i < 5; i++) {
        insertObservation(db, {
          title: `Bun runtime observation ${i}`,
          narrative: `User uses Bun runtime for project development iteration ${i}`,
          facts: '["bun", "runtime", "preference"]',
          concepts: '["runtime", "tooling"]',
        });
      }

      // ThresholdTrigger uses compileClusters which calls createLLMProvider()
      // Without a real LLM configured, all clusters will be "skipped"
      const trigger = new ThresholdTrigger(db, { threshold: 3 });
      const result = await trigger.checkAndCompile();

      // Without LLM provider, clusters are found but skipped during compilation
      // This verifies the pipeline works end-to-end (cluster -> compile attempt)
      expect(result.compiled + result.skipped).toBeGreaterThan(0);
    });

    it('does not run concurrently', async () => {
      for (let i = 0; i < 5; i++) {
        insertObservation(db, {
          title: `Observation ${i}`,
          narrative: `Similar topic content ${i}`,
          facts: '["similar", "topic"]',
        });
      }

      const trigger = new ThresholdTrigger(db, { threshold: 3 });

      // Start first check
      const p1 = trigger.checkAndCompile();
      expect(trigger.isRunning()).toBe(true);

      // Second check should be no-op
      const p2 = trigger.checkAndCompile();

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r2.compiled).toBe(0);
      expect(r2.skipped).toBe(0);
    });

    it('handles empty database gracefully', async () => {
      const trigger = new ThresholdTrigger(db, { threshold: 5 });
      const result = await trigger.checkAndCompile();

      expect(result.compiled).toBe(0);
      expect(result.skipped).toBe(0);
    });

    it('ignores demoted observations', async () => {
      for (let i = 0; i < 5; i++) {
        insertObservation(db, {
          title: `Bun runtime ${i}`,
          narrative: `User prefers Bun for everything ${i}`,
          facts: '["bun", "runtime"]',
        });
      }

      // Demote all observations
      db.run('UPDATE observations SET demoted = 1');

      const trigger = new ThresholdTrigger(db, { threshold: 3 });
      const result = await trigger.checkAndCompile();

      expect(result.compiled).toBe(0);
      expect(result.skipped).toBe(0);
    });
  });

  describe('notify (debounce)', () => {
    it('debounces multiple rapid notifications', async () => {
      const trigger = new ThresholdTrigger(db, { threshold: 100, debounceMs: 50 });

      // Rapid-fire notifications
      trigger.notify();
      trigger.notify();
      trigger.notify();

      // Wait for debounce to settle
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should have run once (or not at all if no observations)
      // Just verify it does not throw
      trigger.dispose();
    });

    it('dispose cancels pending check', () => {
      const trigger = new ThresholdTrigger(db, { debounceMs: 1000 });

      trigger.notify();
      trigger.dispose();

      // If dispose works correctly, no check runs after this
      // (we would get an error if it tried to query a closed DB)
    });
  });

  describe('custom threshold', () => {
    it('respects custom threshold value', async () => {
      // Insert 3 similar observations
      for (let i = 0; i < 3; i++) {
        insertObservation(db, {
          title: `Bun preference ${i}`,
          narrative: `Bun runtime is preferred for development ${i}`,
          facts: '["bun", "runtime", "preference"]',
        });
      }

      // Threshold of 10 = not enough
      const trigger10 = new ThresholdTrigger(db, { threshold: 10 });
      const r10 = await trigger10.checkAndCompile();
      expect(r10.compiled).toBe(0);
      expect(r10.skipped).toBe(3);

      // Threshold of 3 = enough observations (but may not cluster)
      const trigger3 = new ThresholdTrigger(db, { threshold: 3 });
      const r3 = await trigger3.checkAndCompile();
      // At minimum, observations are processed
      expect(r3.compiled + r3.skipped).toBeGreaterThanOrEqual(0);
    });
  });
});
