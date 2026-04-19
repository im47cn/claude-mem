/**
 * Synthesize Routes
 *
 * Manual trigger for compiled summary generation.
 * POST /api/synthesize - Run incremental observation compilation
 * GET  /api/synthesize/status - Check last dream cycle status
 */

import express, { Request, Response } from 'express';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { logger } from '../../../../utils/logger.js';
import type { DreamCycleRunner } from '../../dream/DreamCycleRunner.js';

export class SynthesizeRoutes extends BaseRouteHandler {
  constructor(private dreamCycleRunner: DreamCycleRunner) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.post('/api/synthesize', this.handleSynthesize.bind(this));
    app.get('/api/synthesize/status', this.handleStatus.bind(this));
  }

  /**
   * POST /api/synthesize - Trigger a manual dream cycle (compilation)
   * Body: { force?: boolean }
   *
   * Returns immediately with cycle report on completion.
   * Returns 409 if a cycle is already running.
   */
  private handleSynthesize = this.wrapHandler(async (_req: Request, res: Response): Promise<void> => {
    if (this.dreamCycleRunner.isRunning()) {
      res.status(409).json({
        success: false,
        error: 'A dream cycle is already running. Try again later.',
      });
      return;
    }

    logger.info('HTTP', 'Manual dream cycle triggered via POST /api/synthesize');

    try {
      const report = await this.dreamCycleRunner.run();

      res.json({
        success: true,
        report: {
          status: report.status,
          startedAt: report.startedAt,
          completedAt: report.completedAt,
          durationMs: report.completedAt ? report.completedAt - report.startedAt : null,
          phases: {
            cluster: report.phases.cluster ?? null,
            compile: report.phases.compile ?? null,
            cleanup: report.phases.cleanup ?? null,
            refresh: report.phases.refresh ?? null,
          },
        },
      });
    } catch (error) {
      logger.error('HTTP', 'Manual dream cycle failed', {}, error as Error);
      res.status(500).json({
        success: false,
        error: (error as Error).message,
      });
    }
  });

  /**
   * GET /api/synthesize/status - Get last dream cycle run info
   */
  private handleStatus = this.wrapHandler(async (_req: Request, res: Response): Promise<void> => {
    const lastRun = this.dreamCycleRunner.getLastRun();
    const isRunning = this.dreamCycleRunner.isRunning();

    res.json({
      isRunning,
      lastRun: lastRun ? {
        id: lastRun.id,
        status: lastRun.status,
        startedAt: lastRun.started_at,
        completedAt: lastRun.completed_at,
        observationsProcessed: lastRun.observations_processed,
        report: lastRun.report ? (() => { try { return JSON.parse(lastRun.report!); } catch { return null; } })() : null,
      } : null,
    });
  });
}
