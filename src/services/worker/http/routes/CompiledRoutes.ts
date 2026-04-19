/**
 * Compiled Truth Routes
 *
 * API endpoints for the Compiled Truth Synthesis Layer.
 * Provides CRUD operations and compilation triggers for compiled summaries.
 */

import express, { Request, Response } from 'express';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { logger } from '../../../../utils/logger.js';
import {
  getCompiledSummaryById,
  getCompiledSummaryByTopic,
  searchCompiledSummaries,
  getCompiledSummariesForProject,
  getStaleCompiledSummaries,
  countCompiledSummaries,
  getLinkedObservationIds,
  clusterObservations,
  compileAll,
  localSynthesize,
  deleteCompiledSummary,
  markStaleById
} from '../../../sqlite/compiled-summaries/index.js';
import type { Database } from 'bun:sqlite';

export class CompiledRoutes extends BaseRouteHandler {
  constructor(
    private getDb: () => Database
  ) {
    super();
  }

  setupRoutes(app: express.Application): void {
    // Read endpoints
    app.get('/api/compiled-summaries', this.handleList.bind(this));
    app.get('/api/compiled-summaries/search', this.handleSearch.bind(this));
    app.get('/api/compiled-summaries/stats', this.handleStats.bind(this));
    app.get('/api/compiled-summaries/stale', this.handleStale.bind(this));
    app.get('/api/compiled-summaries/clusters', this.handleClusters.bind(this));
    app.get('/api/compiled-summary/:id', this.handleGetById.bind(this));
    app.get('/api/compiled-summary/:id/sources', this.handleGetSources.bind(this));

    // Write endpoints
    app.post('/api/compiled-summaries/compile', this.handleCompile.bind(this));
    app.post('/api/compiled-summary/:id/mark-stale', this.handleMarkStale.bind(this));
    app.delete('/api/compiled-summary/:id', this.handleDelete.bind(this));
  }

  /**
   * List compiled summaries for a project
   * GET /api/compiled-summaries?project=...&limit=50
   */
  private handleList = this.wrapHandler((req: Request, res: Response): void => {
    const project = req.query.project as string;
    const limit = parseInt(req.query.limit as string) || 50;
    const includeStale = req.query.includeStale === 'true';

    if (!project) {
      this.badRequest(res, 'project parameter is required');
      return;
    }

    const summaries = getCompiledSummariesForProject(this.getDb(), project, { includeStale, limit });
    res.json({ summaries, count: summaries.length });
  });

  /**
   * Search compiled summaries
   * GET /api/compiled-summaries/search?query=...&project=...&limit=10
   */
  private handleSearch = this.wrapHandler((req: Request, res: Response): void => {
    const query = req.query.query as string;
    const project = req.query.project as string | undefined;
    const limit = parseInt(req.query.limit as string) || 10;

    if (!query) {
      this.badRequest(res, 'query parameter is required');
      return;
    }

    const results = searchCompiledSummaries(this.getDb(), query, { project, limit });
    res.json({ results, count: results.length });
  });

  /**
   * Get compiled summary statistics
   * GET /api/compiled-summaries/stats?project=...
   */
  private handleStats = this.wrapHandler((req: Request, res: Response): void => {
    const project = req.query.project as string | undefined;
    const db = this.getDb();

    const total = countCompiledSummaries(db, { project });
    const stale = countCompiledSummaries(db, { project, staleOnly: true });

    res.json({
      total,
      stale,
      fresh: total - stale
    });
  });

  /**
   * Get stale compiled summaries (needing recompilation)
   * GET /api/compiled-summaries/stale?project=...&limit=20
   */
  private handleStale = this.wrapHandler((req: Request, res: Response): void => {
    const project = req.query.project as string | undefined;
    const limit = parseInt(req.query.limit as string) || 20;

    const stale = getStaleCompiledSummaries(this.getDb(), { project, limit });
    res.json({ summaries: stale, count: stale.length });
  });

  /**
   * Get observation clusters (preview what would be compiled)
   * GET /api/compiled-summaries/clusters?project=...
   */
  private handleClusters = this.wrapHandler((req: Request, res: Response): void => {
    const project = req.query.project as string | undefined;

    const clusters = clusterObservations(this.getDb(), { project });
    res.json({
      clusters: clusters.map(c => ({
        topic: c.topic,
        entityType: c.entityType,
        observationCount: c.observations.length,
        hasExisting: !!c.existing,
        existingId: c.existing?.id
      })),
      count: clusters.length
    });
  });

  /**
   * Get a single compiled summary by ID
   * GET /api/compiled-summary/:id
   */
  private handleGetById = this.wrapHandler((req: Request, res: Response): void => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      this.badRequest(res, 'Invalid ID');
      return;
    }

    const summary = getCompiledSummaryById(this.getDb(), id);
    if (!summary) {
      res.status(404).json({ error: 'Compiled summary not found' });
      return;
    }

    res.json(summary);
  });

  /**
   * Get source observation IDs for a compiled summary
   * GET /api/compiled-summary/:id/sources
   */
  private handleGetSources = this.wrapHandler((req: Request, res: Response): void => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      this.badRequest(res, 'Invalid ID');
      return;
    }

    const ids = getLinkedObservationIds(this.getDb(), id);
    res.json({ observation_ids: ids, count: ids.length });
  });

  /**
   * Trigger compilation (local synthesis, no AI)
   * POST /api/compiled-summaries/compile { project?: string }
   *
   * Uses local synthesis by default. For AI-powered synthesis,
   * use the dream cycle or SDK agent integration.
   */
  private handleCompile = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const project = req.body?.project as string | undefined;

    logger.info('COMPILED', `Compilation triggered for project=${project || 'all'}`);

    const result = await compileAll(this.getDb(), localSynthesize, { project });
    res.json(result);
  });

  /**
   * Mark a compiled summary as stale
   * POST /api/compiled-summary/:id/mark-stale
   */
  private handleMarkStale = this.wrapHandler((req: Request, res: Response): void => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      this.badRequest(res, 'Invalid ID');
      return;
    }

    markStaleById(this.getDb(), id);
    res.json({ success: true });
  });

  /**
   * Delete a compiled summary
   * DELETE /api/compiled-summary/:id
   */
  private handleDelete = this.wrapHandler((req: Request, res: Response): void => {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      this.badRequest(res, 'Invalid ID');
      return;
    }

    deleteCompiledSummary(this.getDb(), id);
    res.json({ success: true });
  });
}
