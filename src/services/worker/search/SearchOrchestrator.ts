/**
 * SearchOrchestrator - Coordinates search strategies and handles fallback logic
 *
 * This is the main entry point for search operations. It:
 * 1. Normalizes input parameters
 * 2. Selects the appropriate strategy
 * 3. Executes the search
 * 4. Handles fallbacks on failure
 * 5. Delegates to formatters for output
 */

import { SessionSearch } from '../../sqlite/SessionSearch.js';
import { SessionStore } from '../../sqlite/SessionStore.js';
import { ChromaSync } from '../../sync/ChromaSync.js';

import { ChromaSearchStrategy } from './strategies/ChromaSearchStrategy.js';
import { SQLiteSearchStrategy } from './strategies/SQLiteSearchStrategy.js';
import { HybridSearchStrategy } from './strategies/HybridSearchStrategy.js';

import { ResultFormatter } from './ResultFormatter.js';
import { TimelineBuilder } from './TimelineBuilder.js';
import type { TimelineItem, TimelineData } from './TimelineBuilder.js';

import {
  SEARCH_CONSTANTS,
} from './types.js';
import type {
  StrategySearchOptions,
  StrategySearchResult,
  SearchResults,
  ObservationSearchResult
} from './types.js';
import { logger } from '../../../utils/logger.js';
import { dedupResults } from './dedup.js';
import { rrfFusion } from './rrf-fusion.js';
import type { RankedResult } from './rrf-fusion.js';
import { CompiledSummaryStore } from './compiled-summaries.js';
import type { CompiledSummarySearchResult } from './types.js';

/**
 * Normalized parameters from URL-friendly format
 */
interface NormalizedParams extends StrategySearchOptions {
  concepts?: string[];
  files?: string[];
  obsType?: string[];
}

export class SearchOrchestrator {
  private chromaStrategy: ChromaSearchStrategy | null = null;
  private sqliteStrategy: SQLiteSearchStrategy;
  private hybridStrategy: HybridSearchStrategy | null = null;
  private resultFormatter: ResultFormatter;
  private timelineBuilder: TimelineBuilder;
  private compiledStore: CompiledSummaryStore | null = null;

  constructor(
    private sessionSearch: SessionSearch,
    private sessionStore: SessionStore,
    private chromaSync: ChromaSync | null
  ) {
    // Initialize strategies
    this.sqliteStrategy = new SQLiteSearchStrategy(sessionSearch);

    if (chromaSync) {
      this.chromaStrategy = new ChromaSearchStrategy(chromaSync, sessionStore);
      this.hybridStrategy = new HybridSearchStrategy(chromaSync, sessionStore, sessionSearch);
    }

    this.resultFormatter = new ResultFormatter();
    this.timelineBuilder = new TimelineBuilder();
  }

  /**
   * Initialize compiled summary store (called after DB is ready)
   */
  setCompiledStore(store: CompiledSummaryStore): void {
    this.compiledStore = store;
  }

  /**
   * Main search entry point
   */
  async search(args: any): Promise<StrategySearchResult> {
    const options = this.normalizeParams(args);

    // Decision tree for strategy selection
    return await this.executeWithFallback(options);
  }

  /**
   * Search compiled summaries first, fall back to observations.
   * Returns compiled summaries alongside regular results.
   */
  async searchWithCompiled(args: any): Promise<StrategySearchResult & {
    compiledSummaries: CompiledSummarySearchResult[];
  }> {
    const options = this.normalizeParams(args);
    const compiledSummaries: CompiledSummarySearchResult[] = [];

    // Check compiled summaries first (if available and query exists)
    if (this.compiledStore && options.query) {
      const compiled = this.compiledStore.searchByText(options.query, {
        project: options.project,
        limit: 5,
      });
      compiledSummaries.push(...compiled);
    }

    // Run normal search
    const result = await this.executeWithFallback(options);

    return {
      ...result,
      compiledSummaries,
    };
  }

  /**
   * Execute search with RRF hybrid fusion, dedup, and fallback logic
   *
   * When query text is provided and Chroma is available:
   *   1. Run FTS5 keyword search + Chroma semantic search in parallel
   *   2. Fuse results via RRF (Reciprocal Rank Fusion)
   *   3. Hydrate full observation data from SQLite
   *   4. Apply dedup pipeline
   *
   * Graceful degradation: if FTS5 or Chroma fails, the other backend's
   * results are used alone. Both failing falls back to filter-only SQLite.
   */
  private async executeWithFallback(
    options: NormalizedParams
  ): Promise<StrategySearchResult> {
    // PATH 1: FILTER-ONLY (no query text) - Use SQLite, apply dedup
    if (!options.query) {
      logger.debug('SEARCH', 'Orchestrator: Filter-only query, using SQLite', {});
      const result = await this.sqliteStrategy.search(options);
      result.results.observations = dedupResults(result.results.observations);
      return result;
    }

    // PATH 2: HYBRID RRF FUSION (query text + Chroma available)
    if (this.chromaStrategy) {
      const limit = options.limit ?? SEARCH_CONSTANTS.DEFAULT_LIMIT;
      const oversampleLimit = limit * 2; // Oversampling for better RRF candidates

      // Run FTS5 and Chroma in parallel
      const [fts5Results, chromaResult] = await Promise.all([
        Promise.resolve().then(() => {
          try {
            return this.sessionSearch.searchObservationsFTS5(options.query!, {
              limit: oversampleLimit,
              project: options.project,
            });
          } catch {
            return [] as { id: number; score: number }[];
          }
        }),
        this.chromaStrategy.search({ ...options, limit: oversampleLimit }),
      ]);

      logger.debug('SEARCH', 'Orchestrator: RRF fusion inputs', {
        fts5Count: fts5Results.length,
        chromaCount: chromaResult.results.observations.length,
        chromaUsed: chromaResult.usedChroma,
      });

      // Build ranked lists for RRF
      const fts5Ranked: RankedResult[] = fts5Results.map(r => ({
        id: r.id,
        score: r.score,
        source: 'fts5' as const,
      }));

      const chromaRanked: RankedResult[] = chromaResult.results.observations.map(obs => ({
        id: obs.id,
        score: obs.score ?? 0,
        source: 'chroma' as const,
      }));

      // Collect non-empty lists for fusion
      const rankedLists = [fts5Ranked, chromaRanked].filter(l => l.length > 0);

      if (rankedLists.length > 0) {
        // Fuse via RRF
        const fused = rrfFusion(rankedLists);
        const fusedIds = fused.slice(0, limit).map(r => r.id);

        logger.debug('SEARCH', 'Orchestrator: RRF fused results', {
          fusedCount: fused.length,
          returnCount: fusedIds.length,
          listsUsed: rankedLists.length,
        });

        // Hydrate full observations from SQLite in fused rank order
        if (fusedIds.length > 0) {
          const observations = this.sessionStore.getObservationsByIds(fusedIds, { limit });
          // Restore RRF rank order
          observations.sort((a, b) => fusedIds.indexOf(a.id) - fusedIds.indexOf(b.id));

          const dedupedObs = dedupResults(observations);

          return {
            results: {
              observations: dedupedObs,
              sessions: chromaResult.results.sessions,
              prompts: chromaResult.results.prompts,
            },
            usedChroma: chromaResult.usedChroma,
            fellBack: false,
            strategy: rankedLists.length > 1 ? 'hybrid' : (fts5Ranked.length > 0 ? 'sqlite' : 'chroma'),
          };
        }
      }

      // Both backends returned empty — fall back to filter-only SQLite
      logger.debug('SEARCH', 'Orchestrator: RRF produced no results, falling back to SQLite', {});
      const fallbackResult = await this.sqliteStrategy.search({
        ...options,
        query: undefined,
      });
      fallbackResult.results.observations = dedupResults(fallbackResult.results.observations);

      return {
        ...fallbackResult,
        fellBack: true,
      };
    }

    // PATH 3: No Chroma available — try FTS5 only
    logger.debug('SEARCH', 'Orchestrator: Chroma not available, trying FTS5 only', {});
    const limit = options.limit ?? SEARCH_CONSTANTS.DEFAULT_LIMIT;

    try {
      const fts5Results = this.sessionSearch.searchObservationsFTS5(options.query!, {
        limit,
        project: options.project,
      });

      if (fts5Results.length > 0) {
        const ids = fts5Results.map(r => r.id);
        const observations = this.sessionStore.getObservationsByIds(ids, { limit });
        observations.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));

        return {
          results: {
            observations: dedupResults(observations),
            sessions: [],
            prompts: [],
          },
          usedChroma: false,
          fellBack: false,
          strategy: 'sqlite',
        };
      }
    } catch {
      // FTS5 not available either
    }

    return {
      results: { observations: [], sessions: [], prompts: [] },
      usedChroma: false,
      fellBack: false,
      strategy: 'sqlite',
    };
  }

  /**
   * Find by concept with hybrid search
   */
  async findByConcept(concept: string, args: any): Promise<StrategySearchResult> {
    const options = this.normalizeParams(args);

    if (this.hybridStrategy) {
      return await this.hybridStrategy.findByConcept(concept, options);
    }

    // Fallback to SQLite
    const results = this.sqliteStrategy.findByConcept(concept, options);
    return {
      results: { observations: results, sessions: [], prompts: [] },
      usedChroma: false,
      fellBack: false,
      strategy: 'sqlite'
    };
  }

  /**
   * Find by type with hybrid search
   */
  async findByType(type: string | string[], args: any): Promise<StrategySearchResult> {
    const options = this.normalizeParams(args);

    if (this.hybridStrategy) {
      return await this.hybridStrategy.findByType(type, options);
    }

    // Fallback to SQLite
    const results = this.sqliteStrategy.findByType(type, options);
    return {
      results: { observations: results, sessions: [], prompts: [] },
      usedChroma: false,
      fellBack: false,
      strategy: 'sqlite'
    };
  }

  /**
   * Find by file with hybrid search
   */
  async findByFile(filePath: string, args: any): Promise<{
    observations: ObservationSearchResult[];
    sessions: any[];
    usedChroma: boolean;
  }> {
    const options = this.normalizeParams(args);

    if (this.hybridStrategy) {
      return await this.hybridStrategy.findByFile(filePath, options);
    }

    // Fallback to SQLite
    const results = this.sqliteStrategy.findByFile(filePath, options);
    return { ...results, usedChroma: false };
  }

  /**
   * Get timeline around anchor
   */
  getTimeline(
    timelineData: TimelineData,
    anchorId: number | string,
    anchorEpoch: number,
    depthBefore: number,
    depthAfter: number
  ): TimelineItem[] {
    const items = this.timelineBuilder.buildTimeline(timelineData);
    return this.timelineBuilder.filterByDepth(items, anchorId, anchorEpoch, depthBefore, depthAfter);
  }

  /**
   * Format timeline for display
   */
  formatTimeline(
    items: TimelineItem[],
    anchorId: number | string | null,
    options: {
      query?: string;
      depthBefore?: number;
      depthAfter?: number;
    } = {}
  ): string {
    return this.timelineBuilder.formatTimeline(items, anchorId, options);
  }

  /**
   * Format search results for display
   */
  formatSearchResults(
    results: SearchResults,
    query: string,
    chromaFailed: boolean = false
  ): string {
    return this.resultFormatter.formatSearchResults(results, query, chromaFailed);
  }

  /**
   * Get result formatter for direct access
   */
  getFormatter(): ResultFormatter {
    return this.resultFormatter;
  }

  /**
   * Get timeline builder for direct access
   */
  getTimelineBuilder(): TimelineBuilder {
    return this.timelineBuilder;
  }

  /**
   * Normalize query parameters from URL-friendly format
   */
  private normalizeParams(args: any): NormalizedParams {
    const normalized: any = { ...args };

    // Parse comma-separated concepts into array
    if (normalized.concepts && typeof normalized.concepts === 'string') {
      normalized.concepts = normalized.concepts.split(',').map((s: string) => s.trim()).filter(Boolean);
    }

    // Parse comma-separated files into array
    if (normalized.files && typeof normalized.files === 'string') {
      normalized.files = normalized.files.split(',').map((s: string) => s.trim()).filter(Boolean);
    }

    // Parse comma-separated obs_type into array
    if (normalized.obs_type && typeof normalized.obs_type === 'string') {
      normalized.obsType = normalized.obs_type.split(',').map((s: string) => s.trim()).filter(Boolean);
      delete normalized.obs_type;
    }

    // Parse comma-separated type (for filterSchema) into array
    if (normalized.type && typeof normalized.type === 'string' && normalized.type.includes(',')) {
      normalized.type = normalized.type.split(',').map((s: string) => s.trim()).filter(Boolean);
    }

    // Map 'type' param to 'searchType' for API consistency
    if (normalized.type && !normalized.searchType) {
      if (['observations', 'sessions', 'prompts'].includes(normalized.type)) {
        normalized.searchType = normalized.type;
        delete normalized.type;
      }
    }

    // Flatten dateStart/dateEnd into dateRange object
    if (normalized.dateStart || normalized.dateEnd) {
      normalized.dateRange = {
        start: normalized.dateStart,
        end: normalized.dateEnd
      };
      delete normalized.dateStart;
      delete normalized.dateEnd;
    }

    return normalized;
  }

  /**
   * Check if Chroma is available
   */
  isChromaAvailable(): boolean {
    return !!this.chromaSync;
  }
}
