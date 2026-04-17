# Spec 003: RRF Hybrid Search Fusion

## Priority: P1 | Value: High | Difficulty: Low

## Status: COMPLETE

## Problem Statement

Claude-mem currently offers two search backends that operate independently:
- **SQLite FTS5**: keyword matching, good for exact terms
- **ChromaDB**: semantic similarity, good for conceptual queries

Users get one or the other, never both fused. A search for "authentication bug"
via FTS5 finds records containing those exact words but misses "JWT token validation
failed". ChromaDB finds semantic matches but may miss exact keyword hits.

GBrain solves this with **Reciprocal Rank Fusion (RRF)** -- a 20-line algorithm
that merges ranked lists from different search backends without caring about
score scale differences.

## GBrain Reference

- Hybrid search: `src/core/search/hybrid.ts` (95 lines total)
- RRF fusion: `src/core/search/hybrid.ts:68-87` (20 lines, core algorithm)
- K constant: 60 (industry standard)

## Implementation

### Architecture

The original spec assumed FTS5 was the primary search backend with ChromaDB as
an optional add-on. In practice, claude-mem evolved to use ChromaDB as the primary
text search engine, with FTS5 tables maintained via triggers but unused for queries.

The implementation re-activates FTS5 as a keyword search backend alongside ChromaDB,
fusing both via RRF for superior search quality.

```
search(query) →
    ├── FTS5 keyword search (SessionSearch.searchObservationsFTS5)
    │   Returns observation IDs ranked by bm25 relevance
    │
    └── ChromaDB semantic search (ChromaSearchStrategy.search)
        Returns observation IDs ranked by vector similarity
    │
    → RRF fusion (rrfFusion) — merges by rank position, not score magnitude
    → Hydrate full observations from SQLite in fused rank order
    → dedupResults (spec 005)
    → return top N
```

### Key Files

| File | Role |
|------|------|
| `src/services/worker/search/rrf-fusion.ts` | Pure RRF algorithm (K=60, configurable) |
| `src/services/worker/search/SearchOrchestrator.ts` | Orchestrates parallel FTS5+Chroma, fuses via RRF |
| `src/services/sqlite/SessionSearch.ts` | New `searchObservationsFTS5()` method |
| `tests/worker/search/rrf-fusion.test.ts` | 9 test cases for RRF algorithm |

### RRF Algorithm

```typescript
// RRF score = sum(1 / (K + rank)) across all lists
// Items appearing in multiple lists accumulate higher scores
export function rrfFusion(lists: RankedResult[][], opts?: { k?: number }): RankedResult[];
```

### Graceful Degradation

Every search enhancement is non-fatal (from GBrain's design philosophy):

| Scenario | Behavior |
|----------|----------|
| FTS5 + Chroma both available | Full RRF fusion (best quality) |
| FTS5 fails, Chroma available | Chroma-only results (semantic search) |
| Chroma fails, FTS5 available | FTS5-only results (keyword search) |
| Both fail | Filter-only SQLite fallback |
| No Chroma configured | FTS5-only (if tables exist), else empty |

### Oversampling Strategy

Request 2x the desired limit from each backend, then trim after fusion:

```
User requests: limit=20
FTS5 fetches: limit=40
ChromaDB fetches: limit=40
RRF fusion: produces ~40-80 candidates
After dedup + trim: return top 20
```

## Acceptance Criteria

- [x] `rrfFusion()` function implemented as pure function with tests
- [x] `searchObservationsFTS5()` added to SessionSearch with bm25 ranking
- [x] SearchOrchestrator runs FTS5 and ChromaDB in parallel via `Promise.all`
- [x] Results correctly fused with RRF scores (K=60)
- [x] Items appearing in both lists rank higher than single-list items
- [x] Graceful degradation when FTS5 or ChromaDB is unavailable
- [x] Oversampling (2x limit) applied to each backend
- [x] Dedup applied after RRF fusion
- [x] Comprehensive unit tests for RRF algorithm (9 test cases)

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| FTS5 not available on some platforms (Bun/Windows) | Non-fatal: `searchObservationsFTS5` returns empty array |
| ChromaDB latency slows searches | Parallel execution; FTS5 results available immediately |
| FTS5 tables empty (no triggers fired) | Graceful: empty FTS5 list = Chroma-only results |
| RRF K constant may need tuning | K=60 is the academic standard; configurable via `RRFOptions.k` |

## Testing

File: `tests/worker/search/rrf-fusion.test.ts` (9 test cases)

- Dual-list items rank higher than single-list items
- Single list graceful handling
- Empty lists handling
- Custom K constant support
- 3-list fusion
- FTS5 + ChromaDB simulation
- Rank-based scoring (ignores original magnitudes)
