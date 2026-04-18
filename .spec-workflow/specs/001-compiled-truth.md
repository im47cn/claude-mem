# Spec 001: Compiled Truth Synthesis Layer

## Priority: P0 | Value: High | Difficulty: Medium

## Status: IN PROGRESS (Core Complete)

## Problem Statement

Claude-mem stores observations as flat, chronological records. As observation count grows,
search results become fragmented -- the agent receives 10 individual observations about
"user prefers Bun runtime" instead of one synthesized summary. This wastes tokens and
forces the agent to re-synthesize context on every session.

GBrain solves this with the **Compiled Truth + Timeline** pattern: a rewritable synthesis
layer above an append-only evidence trail. The compiled truth gives you the state of play
in 30 seconds; the timeline is the proof.

## GBrain Reference

- Source: `docs/guides/compiled-truth.md`
- Data model: `src/core/types.ts` (Page interface with `compiled_truth` + `timeline` fields)
- Update logic: `src/core/operations.ts` (`put_page` + `add_timeline_entry`)

### GBrain's Model

```
Page:
  compiled_truth: "User strongly prefers Bun runtime + Vite build.
                   Adopted across 3 projects. Actively migrating from Node."
  ---
  timeline:
    - 2026-04-01: Used Bun in project-a [Source: session-xxx]
    - 2026-04-05: Stated dislike for webpack [Source: session-yyy]
    - 2026-04-10: Used Bun in project-b [Source: session-zzz]
    - 2026-04-13: Migrated project-c from Node to Bun [Source: session-www]
```

**Rules:**
- Compiled truth is REWRITTEN (not appended) when new evidence arrives
- Timeline is APPEND-ONLY (never edited)
- Every compiled truth claim must trace to timeline entries

## Proposed Design for Claude-Mem

### New Concept: Compiled Summary

Introduce a `compiled_summaries` table that sits above `observations`:

```sql
CREATE TABLE compiled_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,              -- e.g., "user-preferences/runtime"
  entity_type TEXT NOT NULL,        -- 'preference', 'pattern', 'decision', 'project', 'tool'
  compiled_text TEXT NOT NULL,      -- current synthesis (rewritable)
  confidence REAL DEFAULT 0.8,     -- 0.0-1.0, based on evidence count
  observation_ids TEXT NOT NULL,    -- JSON array of source observation IDs
  project TEXT,                     -- optional project scope
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_compiled_topic ON compiled_summaries(topic);
CREATE INDEX idx_compiled_type ON compiled_summaries(entity_type);
CREATE INDEX idx_compiled_project ON compiled_summaries(project);
```

### Relationship to Existing Observations

```
observations (existing, unchanged - acts as Timeline)
  │
  │  N:1 relationship
  ▼
compiled_summaries (NEW - acts as Compiled Truth)
  │
  │  referenced by
  ▼
search results (return compiled_summaries first, observations as fallback)
```

### Compilation Logic

A new worker agent (using claude-agent-sdk) periodically compiles observations:

```typescript
interface CompilationTask {
  // Group observations by semantic similarity
  cluster: Observation[];
  // Existing compiled summary for this topic (if any)
  existing?: CompiledSummary;
  // Action: 'create' | 'update' | 'merge'
  action: string;
}

async function compileObservations(task: CompilationTask): Promise<CompiledSummary> {
  // If no existing summary, create new
  // If existing summary + new observations, REWRITE (not append)
  // Agent SDK generates the synthesis
  const prompt = `
    Given these observations about "${task.cluster[0].topic}":
    ${task.cluster.map(o => `- ${o.content} [${o.timestamp}]`).join('\n')}

    ${task.existing ? `Current summary: ${task.existing.compiled_text}` : ''}

    Write a concise, current-state summary. REWRITE completely, do not append.
    Every claim must be traceable to the observations above.
  `;
  // ...
}
```

### Search Integration

Modify the existing `search` MCP tool to prefer compiled summaries:

```
search("Bun runtime") →
  1. Check compiled_summaries first (topic match + FTS)
  2. If found: return compiled_text + observation_count + confidence
  3. If not found: fall back to raw observations (current behavior)
```

Token savings: searching "Bun runtime" returns 1 compiled summary (~50 tokens)
instead of 10 individual observations (~500 tokens). **~10x reduction**.

### Compilation Triggers

1. **Threshold-based**: When 5+ observations share a topic cluster, trigger compilation
2. **Time-based**: Run compilation sweep every 6 hours in the worker
3. **Dream Cycle**: Full compilation pass during dream cycle (see spec-006)

## Migration Strategy

1. No changes to existing `observations` table (backward compatible)
2. New `compiled_summaries` table added via migration
3. Search MCP tool gains a `prefer_compiled: boolean` parameter (default: true)
4. Existing `get_observations` tool unchanged (raw access preserved)

## Implementation

### Architecture

The Compiled Truth pattern is implemented as three independent layers:

```
1. Storage Layer (CompiledSummaryStore)
   - compiled_summaries table via migration 26
   - CRUD + upsert with REWRITE semantics
   - Text search (LIKE-based) + project/entity filters

2. Synthesis Layer (Synthesizer)
   - Takes ObservationCluster → produces SynthesizerResult
   - Injected LLMProvider abstraction (Gemini/OpenRouter/Claude)
   - Reuses user's configured CLAUDE_MEM_PROVIDER
   - Graceful degradation: returns null on LLM failure

3. Search Integration (SearchOrchestrator + SearchManager)
   - searchWithCompiled() checks compiled summaries first
   - Compiled summaries rendered before raw observations
   - ~10x token reduction for repeated topics
```

### Key Files

| File | Role |
|------|------|
| `src/services/worker/search/compiled-summaries.ts` | Storage layer: CompiledSummaryStore (CRUD + upsert) |
| `src/services/worker/search/synthesizer.ts` | Core Synthesizer class (cluster → compiled summary) |
| `src/services/worker/search/synthesizer-prompts.ts` | Prompt templates (system + user) |
| `src/services/worker/search/synthesizer-providers.ts` | LLMProvider interface + 3 concrete providers |
| `src/services/worker/search/types.ts` | CompiledSummaryRow, CompiledSummaryInput, SynthesizerResult |
| `src/services/worker/search/SearchOrchestrator.ts` | searchWithCompiled() integration |
| `src/services/worker/SearchManager.ts` | Compiled summaries in search output |
| `src/services/worker/dream/compiler.ts` | Dream Cycle Phase 2: bridges Synthesizer into pipeline |
| `src/services/sqlite/migrations/runner.ts` | Migration 26: compiled_summaries table |

### Synthesizer Design

```typescript
// Input: pre-clustered observations (from Dream Cycle Phase 1 or other)
class Synthesizer {
  constructor(private llm: LLMProvider)
  async synthesize(cluster: ObservationCluster, existing?: CompiledSummaryRow): Promise<SynthesizerResult | null>
  async synthesizeBatch(clusters: ObservationCluster[], opts?): Promise<SynthesizerResult[]>
}

// Confidence formula: min(0.5 + observation_count * 0.1, 1.0)
// REWRITE: existing compiled_text included in prompt for re-synthesis
```

### Remaining Work (Triggers)

The Synthesizer is a standalone component. It needs callers to trigger it:

| Trigger | Status | Description |
|---------|--------|-------------|
| Dream Cycle Phase 2 | **Connected** | `compiler.ts` bridges Synthesizer into Dream Cycle via `compileClusters()` with DI support |
| Threshold-based | Not implemented | Auto-trigger when 5+ observations share a topic cluster |
| Time-based | Not implemented | Run compilation sweep every 6 hours in worker |
| Manual API | Not implemented | `POST /synthesize` endpoint for manual triggering |

## Acceptance Criteria

- [x] `compiled_summaries` table created with proper indexes
- [x] Worker agent can cluster related observations and generate compilations
- [x] Compiled summaries are REWRITTEN (not appended) on new evidence
- [x] `search` MCP tool returns compiled summaries when available
- [x] `observation_ids` field correctly traces back to source observations
- [x] Token usage for typical queries reduced by 50%+ when compiled summaries exist
- [x] Existing observation flow is completely unchanged (no regressions)

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| AI compilation introduces errors | `observation_ids` provides traceability; `confidence` field signals reliability |
| Compilation cost (API calls) | Batch processing; only compile when 5+ observations cluster; use Haiku for cost efficiency |
| Stale compiled summaries | `updated_at` tracking; Dream Cycle refreshes; mark stale when new observations arrive |
| Schema migration on existing installs | SQLite migration is additive (new table only); no existing data touched |

## Testing

### Storage Layer
File: `tests/worker/search/compiled-summaries.test.ts` (17 tests)
- Upsert create/update with REWRITE semantics
- Auto-confidence calculation
- Text search, project filter, entity type filter
- Global summaries, delete, count

### Synthesizer
File: `tests/worker/search/synthesizer.test.ts` (13 tests)
- Single cluster synthesis with mock LLM
- Confidence formula verification (0.8 for 3 obs, 1.0 for 10 obs)
- Graceful degradation (null/empty LLM response)
- REWRITE mode (existing summary in prompt)
- Global clusters (null project)
- Batch processing: sequential execution, skip-on-failure, onProgress callback

### Prompt Templates
File: `tests/worker/search/synthesizer-prompts.test.ts` (7 tests)
- System prompt contains REWRITE + traceable instructions
- User prompt: topic, entityType, project, observations formatting
- CREATE vs REWRITE mode prompt paths
- Null field handling in observations

### Dream Cycle Compiler
File: `tests/worker/dream/compiler.test.ts` (6 tests)
- Create new compiled summaries from clusters
- Update existing summaries (REWRITE mode)
- Skipped clusters on LLM failure
- Graceful degradation with no LLM provider
- Empty clusters array handling
- Mixed create/update reporting
