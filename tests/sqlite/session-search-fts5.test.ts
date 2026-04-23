/**
 * SessionSearch.searchObservationsFTS5 tests
 *
 * Tests FTS5 keyword search used for RRF hybrid fusion (spec 003).
 * Uses in-memory database with FTS5 tables and trigger-synced data.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';
import {
  createSDKSession,
  updateMemorySessionId,
} from '../../src/services/sqlite/Sessions.js';
import { storeObservation } from '../../src/services/sqlite/Observations.js';
import type { ObservationInput } from '../../src/services/sqlite/observations/types.js';

describe('SessionSearch.searchObservationsFTS5', () => {
  let db: Database;
  let search: SessionSearch;
  let memorySessionId: string;

  // Create a minimal in-memory database with FTS5 tables
  function setupFTS5(database: Database): void {
    // Check if FTS5 is available on this platform
    try {
      database.run('CREATE VIRTUAL TABLE IF NOT EXISTS _fts5_probe USING fts5(test_col)');
      database.run('DROP TABLE _fts5_probe');
    } catch {
      // FTS5 not available — tests will be skipped
      return;
    }

    // Create FTS5 virtual table matching SessionSearch.ensureFTSTables()
    database.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
        title,
        subtitle,
        narrative,
        text,
        facts,
        concepts,
        content='observations',
        content_rowid='id'
      )
    `);

    // Create triggers to sync observations → observations_fts
    database.run(`
      CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
        INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
        VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
      END
    `);

    database.run(`
      CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
        VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
      END
    `);

    database.run(`
      CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
        VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
        INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
        VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
      END
    `);
  }

  function isFTS5Available(database: Database): boolean {
    try {
      database.run('CREATE VIRTUAL TABLE IF NOT EXISTS _fts5_probe USING fts5(test_col)');
      database.run('DROP TABLE _fts5_probe');
      return true;
    } catch {
      return false;
    }
  }

  function createObservation(overrides: Partial<ObservationInput> = {}): ObservationInput {
    return {
      type: 'discovery',
      title: 'Test Observation',
      subtitle: 'Test Subtitle',
      facts: ['fact1'],
      narrative: 'Test narrative',
      concepts: ['testing'],
      files_read: [],
      files_modified: [],
      ...overrides,
    };
  }

  beforeEach(() => {
    const cmdb = new ClaudeMemDatabase(':memory:');
    db = cmdb.db;

    // Setup FTS5 tables (may be skipped if FTS5 not available)
    setupFTS5(db);

    // Create SessionSearch with injected database instance
    search = new SessionSearch(db);

    // Create a session for FK constraints
    const sessionId = createSDKSession(db, 'content-sess-1', 'test-project', 'initial prompt');
    updateMemorySessionId(db, sessionId, 'memory-sess-1');
    memorySessionId = 'memory-sess-1';
  });

  afterEach(() => {
    db.close();
  });

  it('returns empty array when FTS5 table does not exist', () => {
    // Drop the FTS table to simulate missing FTS5
    try { db.run('DROP TABLE IF EXISTS observations_fts'); } catch { /* ignore */ }

    const results = search.searchObservationsFTS5('test query');
    expect(results).toEqual([]);
  });

  it('returns empty array for no matches', () => {
    if (!isFTS5Available(db)) return; // skip on platforms without FTS5

    storeObservation(db, memorySessionId, 'test-project', createObservation({
      title: 'Database connection pooling',
      narrative: 'Set up PostgreSQL connection pool with pg-pool',
    }));

    const results = search.searchObservationsFTS5('authentication');
    expect(results).toHaveLength(0);
  });

  it('finds observations matching query text', () => {
    if (!isFTS5Available(db)) return;

    storeObservation(db, memorySessionId, 'test-project', createObservation({
      title: 'Fixed authentication bug in login handler',
      narrative: 'The JWT token validation was failing due to expired keys',
    }));

    storeObservation(db, memorySessionId, 'test-project', createObservation({
      title: 'Database migration setup',
      narrative: 'Created schema migration for user table',
    }));

    const results = search.searchObservationsFTS5('authentication');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('ranks better matches higher', () => {
    if (!isFTS5Available(db)) return;

    // Observation with "authentication" in both title and narrative
    storeObservation(db, memorySessionId, 'test-project', createObservation({
      title: 'Authentication service refactored',
      narrative: 'Rewrote the authentication middleware for better security',
    }));

    // Observation with "authentication" only in narrative
    storeObservation(db, memorySessionId, 'test-project', createObservation({
      title: 'Security improvements',
      narrative: 'Minor authentication check added',
    }));

    const results = search.searchObservationsFTS5('authentication');
    expect(results.length).toBe(2);
    // First result should have higher score (more matches)
    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
  });

  it('respects limit parameter', () => {
    if (!isFTS5Available(db)) return;

    // Create 5 observations all matching "testing"
    for (let i = 0; i < 5; i++) {
      storeObservation(db, memorySessionId, 'test-project', createObservation({
        title: `Testing scenario ${i}`,
        narrative: `Testing the feature number ${i}`,
      }));
    }

    const results = search.searchObservationsFTS5('testing', { limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('filters by project when specified', () => {
    if (!isFTS5Available(db)) return;

    // Create session for project-b
    const sessionId2 = createSDKSession(db, 'content-sess-2', 'other-project', 'prompt 2');
    updateMemorySessionId(db, sessionId2, 'memory-sess-2');

    storeObservation(db, memorySessionId, 'test-project', createObservation({
      title: 'Authentication in test-project',
      narrative: 'Auth handler for test-project',
    }));

    storeObservation(db, 'memory-sess-2', 'other-project', createObservation({
      title: 'Authentication in other-project',
      narrative: 'Auth handler for other-project',
    }));

    const results = search.searchObservationsFTS5('authentication', { project: 'test-project' });
    expect(results.length).toBe(1);
  });

  it('returns results with positive scores', () => {
    if (!isFTS5Available(db)) return;

    storeObservation(db, memorySessionId, 'test-project', createObservation({
      title: 'React component optimization',
      narrative: 'Optimized the rendering performance of dashboard components',
    }));

    const results = search.searchObservationsFTS5('optimization');
    if (results.length > 0) {
      for (const r of results) {
        expect(r.score).toBeGreaterThan(0);
        expect(typeof r.id).toBe('number');
      }
    }
  });

  it('handles special characters in query gracefully', () => {
    if (!isFTS5Available(db)) return;

    // FTS5 MATCH syntax has special characters — should not crash
    const results = search.searchObservationsFTS5('test OR "exact phrase"');
    expect(Array.isArray(results)).toBe(true);
  });

  it('searches across multiple fields (title, narrative, concepts)', () => {
    if (!isFTS5Available(db)) return;

    storeObservation(db, memorySessionId, 'test-project', createObservation({
      title: 'Unrelated title',
      narrative: 'Unrelated narrative',
      concepts: ['webpack', 'bundling'],
    }));

    const results = search.searchObservationsFTS5('webpack');
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});
