import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { DreamCycleRunner } from '../../../src/services/worker/dream/DreamCycleRunner.js';

/**
 * Helper: create minimal tables needed for DreamCycleRunner query methods.
 * Note: Full run() requires additional tables (FTS5, content_hash, etc.)
 * that are created by the migration runner. These tests focus on the
 * query/status methods that support the Manual API and Time-based trigger.
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
      content_hash TEXT,
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
    CREATE TABLE dream_cycle_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      status TEXT NOT NULL DEFAULT 'running',
      report TEXT,
      observations_processed INTEGER DEFAULT 0
    );
    CREATE INDEX idx_dream_cycle_status ON dream_cycle_runs(status);
    CREATE INDEX idx_dream_cycle_started ON dream_cycle_runs(started_at DESC);
  `);
}

describe('DreamCycleRunner (Manual API + Time-based trigger)', () => {
  let db: Database;
  let runner: DreamCycleRunner;

  beforeEach(() => {
    db = new Database(':memory:');
    createTestTables(db);
    runner = new DreamCycleRunner(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('status queries', () => {
    it('isRunning returns false initially', () => {
      expect(runner.isRunning()).toBe(false);
    });

    it('getLastRun returns null when no runs exist', () => {
      expect(runner.getLastRun()).toBeNull();
    });

    it('getLastDreamCycleTime returns 0 when no completed runs', () => {
      expect(runner.getLastDreamCycleTime()).toBe(0);
    });
  });

  describe('countObservationsSince', () => {
    it('returns 0 on empty DB', () => {
      expect(runner.countObservationsSince(0)).toBe(0);
    });

    it('counts non-demoted observations correctly', () => {
      const now = Date.now();
      db.run(
        `INSERT INTO observations (memory_session_id, project, type, title, narrative, facts, concepts, demoted, created_at, created_at_epoch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['sess-1', 'test', 'discovery', 'Test', 'Narrative', '[]', '[]', 0, new Date().toISOString(), now]
      );
      db.run(
        `INSERT INTO observations (memory_session_id, project, type, title, narrative, facts, concepts, demoted, created_at, created_at_epoch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['sess-1', 'test', 'discovery', 'Test 2', 'Narrative 2', '[]', '[]', 0, new Date().toISOString(), now + 1000]
      );

      expect(runner.countObservationsSince(0)).toBe(2);
      expect(runner.countObservationsSince(now)).toBe(1);
      expect(runner.countObservationsSince(now + 2000)).toBe(0);
    });

    it('excludes demoted observations', () => {
      const now = Date.now();
      db.run(
        `INSERT INTO observations (memory_session_id, project, type, title, narrative, facts, concepts, demoted, created_at, created_at_epoch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['sess-1', 'test', 'discovery', 'Active', 'Active obs', '[]', '[]', 0, new Date().toISOString(), now]
      );
      db.run(
        `INSERT INTO observations (memory_session_id, project, type, title, narrative, facts, concepts, demoted, created_at, created_at_epoch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['sess-1', 'test', 'discovery', 'Demoted', 'Demoted obs', '[]', '[]', 1, new Date().toISOString(), now + 1]
      );

      expect(runner.countObservationsSince(0)).toBe(1);
    });
  });

  describe('dream_cycle_runs tracking', () => {
    it('getLastRun returns most recent run', () => {
      db.run(
        `INSERT INTO dream_cycle_runs (started_at, completed_at, status, observations_processed)
         VALUES (?, ?, ?, ?)`,
        [Date.now() - 10000, Date.now() - 5000, 'completed', 25]
      );

      const lastRun = runner.getLastRun();
      expect(lastRun).not.toBeNull();
      expect(lastRun!.status).toBe('completed');
      expect(lastRun!.observations_processed).toBe(25);
    });

    it('getLastDreamCycleTime returns most recent completed time', () => {
      const completedAt = Date.now() - 3600000;
      db.run(
        `INSERT INTO dream_cycle_runs (started_at, completed_at, status, observations_processed)
         VALUES (?, ?, ?, ?)`,
        [completedAt - 1000, completedAt, 'completed', 10]
      );

      expect(runner.getLastDreamCycleTime()).toBe(completedAt);
    });
  });
});
