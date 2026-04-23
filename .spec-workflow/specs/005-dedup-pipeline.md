# Spec 005: 2-Layer Dedup Pipeline

## Priority: P1 | Value: High | Difficulty: Low

## Status: COMPLETE

## Problem Statement

Claude-mem search results often contain redundant entries: the same file mentioned
across multiple observations, near-identical tool outputs from sequential edits, or
the same concept described slightly differently. This wastes tokens in the agent's
context window and dilutes the signal-to-noise ratio.

Currently, claude-mem only deduplicates at ingestion time (30-second content hash
window). Search results have no deduplication.

GBrain implements a 4-layer dedup pipeline that runs on every search result set,
ensuring diverse, non-redundant results.

## GBrain Reference

- Source: `src/core/search/dedup.ts` (107 lines)
- 4 layers: source dedup → text similarity → type diversity → page cap

## Design: Data-Driven 2-Layer Pipeline

The original spec proposed a 4-layer pipeline adapted from GBrain. Empirical
analysis on 3,700+ real observations revealed that 2 of the 4 layers were
ineffective or redundant in claude-mem's data model:

### Why 4 Layers Became 2

| Original Layer | GBrain | Claude-Mem Finding | Decision |
|----------------|--------|-------------------|----------|
| L1: Source dedup | Per page (top 3) | Redundant with L4 (both cap by session) | **Merged into L2** |
| L2: Text similarity | Jaccard > 0.85 | **Zero hits** on 3,700+ obs at 0.6 threshold | **Removed** |
| L3: Type diversity | Per page type | Low collateral damage (~4% drop, ~3.7% fact loss) | **Retained as L1** |
| L4: Cap | Per page cap | Effective at preventing session dominance | **Retained as L2** |

### Empirical Results (14 queries x 50 results on real dataset)

| Pipeline | Drop Rate | Fact Loss | High-Score Drops |
|----------|-----------|-----------|-----------------|
| Old 4-layer | 51.7% | 53.0% | Many (near-random truncation) |
| New 2-layer (cap=5) | 23.6% | 24.3% | Some |
| New 2-layer (cap=8) | 12.3% | 12.1% | 0 |

### Final 2-Layer Pipeline

```
Layer 1 (Project Diversity): No single project > 60% of results
Layer 2 (Session Cap):       Max 8 results per session in final output
```

### Implementation

File: `src/services/worker/search/dedup.ts`

```typescript
export interface DedupableResult {
  id: number;
  text: string | null;
  title: string | null;
  narrative: string | null;
  score?: number;
  memory_session_id?: string;
  project?: string;
}

export interface DedupOptions {
  maxProjectRatio?: number;  // default: 0.6
  maxPerSession?: number;    // default: 8
}

export function dedupResults<T extends DedupableResult>(
  results: T[],
  opts: DedupOptions = {}
): T[];
```

### Integration

Dedup is applied as the final step in every search path within `SearchOrchestrator`:

```
search(query) →
  strategy execution (Chroma / SQLite / RRF) →
  dedupResults() →
  return top N
```

### Configuration

```json
// ~/.claude-mem/settings.json
{
  "search": {
    "dedup_max_project_ratio": 0.6,
    "dedup_max_per_session": 8
  }
}
```

## Acceptance Criteria

- [x] `dedupResults()` implements 2-layer pipeline (project diversity + session cap)
- [x] Layer 1 prevents single-project dominance in cross-project searches
- [x] Layer 2 caps results per session with configurable limit (default: 8)
- [x] No performance regression for small result sets (< 10 results)
- [x] Configurable thresholds via `DedupOptions`
- [x] Comprehensive unit tests (12 test cases across 4 groups)
- [x] Integrated into SearchOrchestrator (3 search paths)

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Over-aggressive dedup removes relevant results | Conservative defaults (cap=8, ratio=0.6); all thresholds configurable |
| Performance on large result sets | O(n) pipeline; negligible overhead |

## Testing

File: `tests/worker/search/dedup.test.ts`

- Layer 1 tests: project diversity cap enforcement, balanced project preservation
- Layer 2 tests: session cap with defaults, custom caps, session diversity
- Combined layer tests: L1 filters before L2, both layers compose correctly
- Edge cases: empty arrays, single results, custom options
