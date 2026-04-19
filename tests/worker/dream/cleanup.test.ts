import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  runCleanup,
  findDuplicatesByHash,
  mergeDuplicateGroup,
  demoteStaleObservations,
  detectContradictions,
} from '../../../src/services/worker/dream/cleanup.js';

// ---------------------------------------------------------------------------
// DB Setup Helpers
// ---------------------------------------------------------------------------

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      title TEXT,
      subtitle TEXT,
      narrative TEXT,
      facts TEXT,
      concepts TEXT,
      type TEXT NOT NULL DEFAULT 'discovery',
      content_hash TEXT,
      created_at_epoch INTEGER NOT NULL,
      demoted INTEGER DEFAULT 0
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
    CREATE TABLE contradictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      observation_id_a INTEGER NOT NULL,
      observation_id_b INTEGER NOT NULL,
      description TEXT,
      resolved INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

function createDbWithoutContradictions(): Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      title TEXT,
      subtitle TEXT,
      narrative TEXT,
      facts TEXT,
      concepts TEXT,
      type TEXT NOT NULL DEFAULT 'discovery',
      content_hash TEXT,
      created_at_epoch INTEGER NOT NULL,
      demoted INTEGER DEFAULT 0
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
  `);
  return db;
}

const OLD_EPOCH = Date.now() - (100 * 24 * 60 * 60 * 1000); // 100 days ago
const NOW_EPOCH = Date.now();

function insertObs(db: Database, opts: {
  project?: string;
  type?: string;
  title?: string;
  narrative?: string;
  content_hash?: string | null;
  created_at_epoch?: number;
  demoted?: number;
}): number {
  const r = db.query(
    `INSERT INTO observations
       (memory_session_id, project, type, title, narrative, content_hash, created_at_epoch, demoted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'sess-1',
    opts.project ?? 'test-project',
    opts.type ?? 'discovery',
    opts.title ?? 'Test observation',
    opts.narrative ?? null,
    opts.content_hash ?? null,
    opts.created_at_epoch ?? NOW_EPOCH,
    opts.demoted ?? 0,
  );
  return Number(r.lastInsertRowid);
}

function insertCompiledSummary(db: Database, observationIds: number[]): void {
  db.query(
    `INSERT INTO compiled_summaries
       (topic, entity_type, compiled_text, confidence, observation_ids, project, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('test/topic', 'pattern', 'Summary', 0.8,
    JSON.stringify(observationIds), 'test-project', NOW_EPOCH, NOW_EPOCH);
}

function isDemoted(db: Database, id: number): boolean {
  const row = db.query<{ demoted: number }, [number]>(
    'SELECT demoted FROM observations WHERE id = ?'
  ).get(id);
  return row?.demoted === 1;
}

// ---------------------------------------------------------------------------
// findDuplicatesByHash
// ---------------------------------------------------------------------------

describe('findDuplicatesByHash', () => {
  it('returns empty when no duplicates exist', () => {
    const db = createTestDb();
    insertObs(db, { content_hash: 'abc123' });
    expect(findDuplicatesByHash(db)).toEqual([]);
  });

  it('returns duplicate groups when hash shared by multiple observations', () => {
    const db = createTestDb();
    insertObs(db, { content_hash: 'hash-x' });
    insertObs(db, { content_hash: 'hash-x' });
    insertObs(db, { content_hash: 'hash-x' });
    const groups = findDuplicatesByHash(db);
    expect(groups.length).toBe(1);
    expect(groups[0].length).toBe(3);
  });

  it('ignores already-demoted observations', () => {
    const db = createTestDb();
    insertObs(db, { content_hash: 'hash-y', demoted: 1 });
    insertObs(db, { content_hash: 'hash-y', demoted: 0 });
    expect(findDuplicatesByHash(db)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// mergeDuplicateGroup
// ---------------------------------------------------------------------------

describe('mergeDuplicateGroup', () => {
  it('keeps highest id, demotes the rest', () => {
    const db = createTestDb();
    const id1 = insertObs(db, { content_hash: 'h1' });
    const id2 = insertObs(db, { content_hash: 'h1' });
    const id3 = insertObs(db, { content_hash: 'h1' });

    const demoted = mergeDuplicateGroup(db, [id1, id2, id3]);
    expect(demoted).toBe(2);

    const highest = Math.max(id1, id2, id3);
    expect(isDemoted(db, highest)).toBe(false);
    for (const id of [id1, id2, id3].filter(x => x !== highest)) {
      expect(isDemoted(db, id)).toBe(true);
    }
  });

  it('returns 0 for a single-element group', () => {
    const db = createTestDb();
    const id = insertObs(db, {});
    expect(mergeDuplicateGroup(db, [id])).toBe(0);
    expect(isDemoted(db, id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// demoteStaleObservations
// ---------------------------------------------------------------------------

describe('demoteStaleObservations', () => {
  it('demotes old observation not referenced by any compiled summary', () => {
    const db = createTestDb();
    const id = insertObs(db, { created_at_epoch: OLD_EPOCH });
    expect(demoteStaleObservations(db, 90)).toBe(1);
    expect(isDemoted(db, id)).toBe(true);
  });

  it('does NOT demote recent observations', () => {
    const db = createTestDb();
    const id = insertObs(db, { created_at_epoch: NOW_EPOCH });
    expect(demoteStaleObservations(db, 90)).toBe(0);
    expect(isDemoted(db, id)).toBe(false);
  });

  it('does NOT demote observation correctly referenced by compiled summary', () => {
    const db = createTestDb();
    const id = insertObs(db, { created_at_epoch: OLD_EPOCH });
    insertCompiledSummary(db, [id]);
    expect(demoteStaleObservations(db, 90)).toBe(0);
    expect(isDemoted(db, id)).toBe(false);
  });

  it('does not double-demote already-demoted observations', () => {
    const db = createTestDb();
    insertObs(db, { created_at_epoch: OLD_EPOCH, demoted: 1 });
    expect(demoteStaleObservations(db, 90)).toBe(0);
  });

  // BUG EXPOSURE: LIKE '%' || o.id || '%' substring matching bug.
  //
  // observation_ids = '[10,21]'
  // Query: LIKE '%' || 1 || '%' → LIKE '%1%'
  // '%1%' matches the string '[10,21]' because '10' and '21' both contain '1'
  //
  // Expected: id=1 is OLD and NOT in summary → should be demoted
  // Actual:   id=1 is NOT demoted because LIKE '%1%' falsely matches '[10,21]'
  //
  // Fix: use explicit JSON boundary patterns:
  //   '[' || id || ']' OR '[' || id || ',%' OR '%,' || id || ']' OR '%,' || id || ',%'
  it('TODO(bug): demotes id=1 when compiled_summaries only references ids [10,21]', () => {
    const db = createTestDb();
    db.query(
      `INSERT INTO observations
         (id, memory_session_id, project, type, title, content_hash, created_at_epoch, demoted)
       VALUES (1, 'sess', 'proj', 'discovery', 'old', NULL, ${OLD_EPOCH}, 0)`
    ).run();
    db.query(
      `INSERT INTO compiled_summaries
         (topic, entity_type, compiled_text, confidence, observation_ids, project, created_at, updated_at)
       VALUES ('t', 'pattern', 'text', 0.8, '[10,21]', 'proj', ${NOW_EPOCH}, ${NOW_EPOCH})`
    ).run();

    const count = demoteStaleObservations(db, 90);
    // id=1 should be demoted (not actually referenced)
    expect(count).toBe(1);         // FAILS until bug is fixed
    expect(isDemoted(db, 1)).toBe(true); // FAILS until bug is fixed
  });
});

// ---------------------------------------------------------------------------
// detectContradictions
// ---------------------------------------------------------------------------

describe('detectContradictions', () => {
  it('returns 0 for fewer than 2 observations', () => {
    const db = createTestDb();
    insertObs(db, { type: 'decision', title: 'Use TypeScript always everywhere' });
    expect(detectContradictions(db)).toBe(0);
  });

  it('flags two high-overlap decision observations in same project', () => {
    const db = createTestDb();
    insertObs(db, {
      type: 'decision',
      title: 'typescript runtime configuration bun setup recommended',
      narrative: 'always use typescript runtime configuration bun',
    });
    insertObs(db, {
      type: 'decision',
      title: 'typescript runtime configuration bun setup required',
      narrative: 'must always use typescript runtime configuration bun',
    });
    expect(detectContradictions(db)).toBeGreaterThanOrEqual(1);
  });

  it('does not flag decisions from different projects', () => {
    const db = createTestDb();
    insertObs(db, {
      project: 'alpha',
      type: 'decision',
      title: 'typescript runtime configuration bun setup',
    });
    insertObs(db, {
      project: 'beta',
      type: 'decision',
      title: 'typescript runtime configuration bun setup',
    });
    expect(detectContradictions(db)).toBe(0);
  });

  it('does not flag non-decision observation types', () => {
    const db = createTestDb();
    insertObs(db, { type: 'discovery', title: 'typescript runtime bun configuration setup excellent' });
    insertObs(db, { type: 'discovery', title: 'typescript runtime bun configuration setup great' });
    expect(detectContradictions(db)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runCleanup
// ---------------------------------------------------------------------------

describe('runCleanup', () => {
  it('returns zero counts for empty DB', () => {
    const db = createTestDb();
    const report = runCleanup(db);
    expect(report.merged).toBe(0);
    expect(report.demoted).toBe(0);
    expect(report.flagged).toBe(0);
  });

  it('runs all three phases: merge + demote + contradiction detection', () => {
    const db = createTestDb();
    insertObs(db, { content_hash: 'dup', created_at_epoch: OLD_EPOCH });
    insertObs(db, { content_hash: 'dup', created_at_epoch: OLD_EPOCH });
    insertObs(db, { created_at_epoch: OLD_EPOCH });

    const report = runCleanup(db, { staleDays: 90 });
    expect(report.merged).toBe(1);
    expect(report.demoted).toBeGreaterThanOrEqual(1);
  });

  it('throws when contradictions table is missing (documents current behavior)', () => {
    const db = createDbWithoutContradictions();
    insertObs(db, {
      type: 'decision',
      title: 'typescript runtime configuration bun setup recommended',
    });
    insertObs(db, {
      type: 'decision',
      title: 'typescript runtime configuration bun setup required',
    });
    // Phase 3c (detectContradictions) throws when table is missing.
    // This test documents the current behavior — Phase 3c has no graceful fallback.
    // TODO: add try/catch in detectContradictions to make this graceful.
    expect(() => runCleanup(db)).toThrow();
  });
});
