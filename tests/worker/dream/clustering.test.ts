import { describe, it, expect } from 'bun:test';
import {
  extractKeywords,
  keywordSimilarity,
  clusterByKeywordOverlap,
  clusterObservations,
} from '../../../src/services/worker/dream/clustering.js';
import type { ObservationForClustering } from '../../../src/services/worker/dream/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeObs(overrides: Partial<ObservationForClustering> = {}): ObservationForClustering {
  return {
    id: overrides.id ?? 1,
    memory_session_id: overrides.memory_session_id ?? 'sess-1',
    project: overrides.project ?? 'test-project',
    title: overrides.title ?? null,
    subtitle: overrides.subtitle ?? null,
    narrative: overrides.narrative ?? null,
    facts: overrides.facts ?? null,
    concepts: overrides.concepts ?? null,
    type: overrides.type ?? 'discovery',
    created_at_epoch: overrides.created_at_epoch ?? Date.now(),
  };
}

/** Build n observations with identical-ish keywords so they cluster together */
function makeClusterableObs(n: number, project = 'proj', type = 'discovery', baseId = 1): ObservationForClustering[] {
  return Array.from({ length: n }, (_, i) => makeObs({
    id: baseId + i,
    project,
    type,
    title: 'typescript runtime bun configuration setup',
    narrative: 'using typescript with bun runtime configuration',
  }));
}

// ---------------------------------------------------------------------------
// keywordSimilarity
// ---------------------------------------------------------------------------

describe('keywordSimilarity', () => {
  it('returns 0 when both sets are empty', () => {
    expect(keywordSimilarity(new Set(), new Set())).toBe(0);
  });

  it('returns 0 when either set is empty', () => {
    expect(keywordSimilarity(new Set(['word']), new Set())).toBe(0);
    expect(keywordSimilarity(new Set(), new Set(['word']))).toBe(0);
  });

  it('returns 1.0 for identical sets', () => {
    const s = new Set(['typescript', 'runtime', 'bun']);
    expect(keywordSimilarity(s, s)).toBe(1.0);
  });

  it('returns 0 for completely disjoint sets', () => {
    const a = new Set(['apple', 'banana']);
    const b = new Set(['carrot', 'daikon']);
    expect(keywordSimilarity(a, b)).toBe(0);
  });

  it('returns correct Jaccard for partial overlap', () => {
    // intersection={b,c} size=2, union={a,b,c,d} size=4 → 0.5
    const a = new Set(['a', 'b', 'c']);
    const b = new Set(['b', 'c', 'd']);
    expect(keywordSimilarity(a, b)).toBeCloseTo(0.5, 5);
  });

  it('is symmetric', () => {
    const a = new Set(['typescript', 'runtime']);
    const b = new Set(['runtime', 'bun', 'configuration']);
    expect(keywordSimilarity(a, b)).toBe(keywordSimilarity(b, a));
  });
});

// ---------------------------------------------------------------------------
// extractKeywords
// ---------------------------------------------------------------------------

describe('extractKeywords', () => {
  it('extracts words from title and narrative', () => {
    // 'with' is in STOP_WORDS; 'using' is NOT (not a bug — stop word list is intentionally minimal)
    const obs = makeObs({ title: 'TypeScript runtime', narrative: 'with Bun runtime' });
    const kw = extractKeywords(obs);
    expect(kw.has('typescript')).toBe(true);
    expect(kw.has('runtime')).toBe(true);
    expect(kw.has('with')).toBe(false); // stop word filtered
  });

  it('filters words with 3 or fewer characters', () => {
    const obs = makeObs({ title: 'Use the bun tool', narrative: null });
    const kw = extractKeywords(obs);
    expect(kw.has('use')).toBe(false);  // 3 chars
    expect(kw.has('the')).toBe(false);  // 3 chars + stop word
    expect(kw.has('tool')).toBe(true);  // 4 chars, not stop word
  });

  it('parses valid facts JSON array', () => {
    const obs = makeObs({ facts: '["prefers bun runtime", "avoids webpack"]' });
    const kw = extractKeywords(obs);
    expect(kw.has('prefers')).toBe(true);
    expect(kw.has('runtime')).toBe(true);
    expect(kw.has('avoids')).toBe(true);
    expect(kw.has('webpack')).toBe(true);
  });

  it('does not throw on malformed JSON facts', () => {
    const obs = makeObs({ facts: '{not valid json[[[' });
    expect(() => extractKeywords(obs)).not.toThrow();
  });

  it('returns empty set when all fields are null', () => {
    const obs = makeObs({ title: null, subtitle: null, narrative: null, facts: null });
    const kw = extractKeywords(obs);
    expect(kw.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// inferEntityType (tested via clusterByKeywordOverlap)
// ---------------------------------------------------------------------------

describe('inferEntityType via clustering', () => {
  it('maps "decision" type observations to "decision" entity type', () => {
    const obs = makeClusterableObs(3, 'proj', 'decision');
    const clusters = clusterByKeywordOverlap(obs, { minSimilarity: 0, minClusterSize: 3 });
    expect(clusters.length).toBeGreaterThan(0);
    expect(clusters[0].entityType).toBe('decision');
  });

  it('maps "feature" type observations to "project" entity type', () => {
    const obs = makeClusterableObs(3, 'proj', 'feature');
    const clusters = clusterByKeywordOverlap(obs, { minSimilarity: 0, minClusterSize: 3 });
    expect(clusters.length).toBeGreaterThan(0);
    expect(clusters[0].entityType).toBe('project');
  });

  it('maps "discovery" type observations to "pattern" entity type', () => {
    const obs = makeClusterableObs(3, 'proj', 'discovery');
    const clusters = clusterByKeywordOverlap(obs, { minSimilarity: 0, minClusterSize: 3 });
    expect(clusters.length).toBeGreaterThan(0);
    expect(clusters[0].entityType).toBe('pattern');
  });

  // BUG EXPOSURE: 'preference' type has no case branch in inferEntityType,
  // so it falls through to default: return 'pattern'.
  // This test documents the bug — it currently FAILS.
  // Fix: add `case 'preference': return 'preference';` to the switch statement.
  it('TODO(bug): maps "preference" type to "preference" entity type (currently returns "pattern")', () => {
    const obs = makeClusterableObs(3, 'proj', 'preference');
    const clusters = clusterByKeywordOverlap(obs, { minSimilarity: 0, minClusterSize: 3 });
    expect(clusters.length).toBeGreaterThan(0);
    // BUG: currently returns 'pattern' because switch has no 'preference' case
    expect(clusters[0].entityType).toBe('preference'); // FAILS until bug is fixed
  });
});

// ---------------------------------------------------------------------------
// clusterByKeywordOverlap
// ---------------------------------------------------------------------------

describe('clusterByKeywordOverlap', () => {
  it('returns empty array for empty input', () => {
    expect(clusterByKeywordOverlap([])).toEqual([]);
  });

  it('returns empty when fewer observations than minClusterSize', () => {
    const obs = makeClusterableObs(2);
    // default minClusterSize is 3
    expect(clusterByKeywordOverlap(obs)).toEqual([]);
  });

  it('returns cluster when observations meet minClusterSize', () => {
    const obs = makeClusterableObs(3);
    const clusters = clusterByKeywordOverlap(obs, { minSimilarity: 0, minClusterSize: 3 });
    expect(clusters.length).toBe(1);
    expect(clusters[0].observations.length).toBe(3);
  });

  it('respects custom minClusterSize', () => {
    const obs = makeClusterableObs(2);
    const clusters = clusterByKeywordOverlap(obs, { minSimilarity: 0, minClusterSize: 2 });
    expect(clusters.length).toBe(1);
  });

  it('minSimilarity=1.0 prevents clustering unless observations are identical', () => {
    const obs = [
      makeObs({ id: 1, title: 'typescript bun runtime' }),
      makeObs({ id: 2, title: 'typescript bun setup' }),
      makeObs({ id: 3, title: 'javascript node runtime' }),
    ];
    // With maximal similarity threshold, only near-identical observations cluster
    const clusters = clusterByKeywordOverlap(obs, { minSimilarity: 1.0, minClusterSize: 2 });
    expect(clusters.length).toBe(0);
  });

  it('cluster includes topic and keywords', () => {
    const obs = makeClusterableObs(3);
    const clusters = clusterByKeywordOverlap(obs, { minSimilarity: 0, minClusterSize: 3 });
    expect(clusters[0].topic).toBeDefined();
    expect(clusters[0].keywords.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// clusterObservations (cross-project isolation)
// ---------------------------------------------------------------------------

describe('clusterObservations', () => {
  it('returns empty for empty input', () => {
    expect(clusterObservations([])).toEqual([]);
  });

  it('does NOT cluster observations from different projects together', () => {
    const projA = makeClusterableObs(3, 'project-alpha', 'discovery', 1);
    const projB = makeClusterableObs(3, 'project-beta', 'discovery', 10);
    const all = [...projA, ...projB];

    const clusters = clusterObservations(all, { minSimilarity: 0, minClusterSize: 3 });
    // Each project gets its own cluster — no cross-project mixing
    for (const cluster of clusters) {
      const projects = new Set(cluster.observations.map(o => o.project));
      expect(projects.size).toBe(1);
    }
  });

  it('clusters similar observations within same project', () => {
    const obs = makeClusterableObs(3, 'myproject', 'discovery', 1);
    const clusters = clusterObservations(obs, { minSimilarity: 0, minClusterSize: 3 });
    expect(clusters.length).toBeGreaterThan(0);
    expect(clusters[0].project).toBe('myproject');
  });

  it('produces separate clusters per project when both have enough observations', () => {
    const projA = makeClusterableObs(3, 'alpha', 'discovery', 1);
    const projB = makeClusterableObs(3, 'beta', 'discovery', 10);
    const clusters = clusterObservations([...projA, ...projB], { minSimilarity: 0, minClusterSize: 3 });
    const projects = new Set(clusters.map(c => c.project));
    expect(projects.has('alpha')).toBe(true);
    expect(projects.has('beta')).toBe(true);
  });
});
