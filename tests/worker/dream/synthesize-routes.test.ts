import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import type { Request, Response } from 'express';
import { logger } from '../../../src/utils/logger.js';

// ---------------------------------------------------------------------------
// Mock Justification:
// - DreamCycleRunner: avoids real DB / LLM calls; we test HTTP handler logic only
// - logger spies: suppress console output during tests
// ---------------------------------------------------------------------------

import { SynthesizeRoutes } from '../../../src/services/worker/http/routes/SynthesizeRoutes.js';
import type { DreamCycleReport, DreamCycleRunRow } from '../../../src/services/worker/dream/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createRes(): { res: Partial<Response>; jsonSpy: ReturnType<typeof mock>; statusChain: { json: ReturnType<typeof mock> } } {
  const statusChainJson = mock((_body: unknown) => {});
  const statusChain = { json: statusChainJson };
  const jsonSpy = mock((_body: unknown) => {});
  const statusSpy = mock((_code: number) => statusChain);
  const res: Partial<Response> = {
    json: jsonSpy as unknown as Response['json'],
    status: statusSpy as unknown as Response['status'],
  };
  return { res, jsonSpy, statusChain };
}

function createReq(body: unknown = {}): Partial<Request> {
  return { body, path: '/api/synthesize', query: {} } as Partial<Request>;
}

function makeReport(overrides: Partial<DreamCycleReport> = {}): DreamCycleReport {
  return {
    startedAt: 1000,
    completedAt: 2000,
    status: 'completed',
    phases: {
      cluster: { observationsProcessed: 5, clustersFound: 2 },
      compile: { created: 1, updated: 1, skipped: 0, errors: [] },
      cleanup: { merged: 0, demoted: 1, flagged: 0 },
      refresh: { fts5Rebuilt: true, compiledSummariesIndexed: 2 },
    },
    ...overrides,
  };
}

function makeRunRow(overrides: Partial<DreamCycleRunRow> = {}): DreamCycleRunRow {
  return {
    id: 1,
    started_at: 1000,
    completed_at: 2000,
    status: 'completed',
    report: JSON.stringify({ status: 'completed' }),
    observations_processed: 5,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// POST /api/synthesize
// ---------------------------------------------------------------------------

describe('POST /api/synthesize', () => {
  let routes: SynthesizeRoutes;
  let mockIsRunning: ReturnType<typeof mock>;
  let mockRun: ReturnType<typeof mock>;
  let loggerSpies: ReturnType<typeof spyOn>[];

  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
    ];

    mockIsRunning = mock(() => false);
    mockRun = mock(async () => makeReport());

    const mockRunner = {
      isRunning: mockIsRunning,
      run: mockRun,
      getLastRun: mock(() => null),
    };

    routes = new SynthesizeRoutes(mockRunner as any);
  });

  afterEach(() => {
    loggerSpies.forEach(s => s.mockRestore());
  });

  it('returns 409 when a cycle is already running', async () => {
    mockIsRunning.mockImplementation(() => true);
    const req = createReq();
    const { res, statusChain } = createRes();

    await (routes as any).handleSynthesize(req, res);

    expect((res.status as ReturnType<typeof mock>).mock.calls[0][0]).toBe(409);
    expect(statusChain.json.mock.calls[0][0]).toMatchObject({
      success: false,
      error: expect.stringContaining('already running'),
    });
  });

  it('returns 200 with report when run completes successfully', async () => {
    const report = makeReport();
    mockRun.mockImplementation(async () => report);

    const req = createReq();
    const { res, jsonSpy } = createRes();

    await (routes as any).handleSynthesize(req, res);

    expect(mockRun).toHaveBeenCalled();
    expect(jsonSpy).toHaveBeenCalled();
    const body = jsonSpy.mock.calls[0][0] as any;
    expect(body.success).toBe(true);
    expect(body.report.status).toBe('completed');
    expect(body.report.durationMs).toBe(1000); // completedAt - startedAt
    expect(body.report.phases.cluster).toBeDefined();
    expect(body.report.phases.compile).toBeDefined();
  });

  it('reports durationMs as null when completedAt is missing', async () => {
    const report = makeReport({ completedAt: undefined });
    mockRun.mockImplementation(async () => report);

    const req = createReq();
    const { res, jsonSpy } = createRes();

    await (routes as any).handleSynthesize(req, res);

    const body = jsonSpy.mock.calls[0][0] as any;
    expect(body.report.durationMs).toBeNull();
  });

  it('returns 500 with error message when run() throws', async () => {
    mockRun.mockImplementation(async () => {
      throw new Error('LLM provider failed');
    });

    const req = createReq();
    const { res, statusChain } = createRes();

    await (routes as any).handleSynthesize(req, res);

    expect((res.status as ReturnType<typeof mock>).mock.calls[0][0]).toBe(500);
    expect(statusChain.json.mock.calls[0][0]).toMatchObject({
      success: false,
      error: 'LLM provider failed',
    });
  });
});

// ---------------------------------------------------------------------------
// GET /api/synthesize/status
// ---------------------------------------------------------------------------

describe('GET /api/synthesize/status', () => {
  let routes: SynthesizeRoutes;
  let mockIsRunning: ReturnType<typeof mock>;
  let mockGetLastRun: ReturnType<typeof mock>;
  let loggerSpies: ReturnType<typeof spyOn>[];

  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
    ];

    mockIsRunning = mock(() => false);
    mockGetLastRun = mock(() => null);

    const mockRunner = {
      isRunning: mockIsRunning,
      run: mock(async () => makeReport()),
      getLastRun: mockGetLastRun,
    };

    routes = new SynthesizeRoutes(mockRunner as any);
  });

  afterEach(() => {
    loggerSpies.forEach(s => s.mockRestore());
  });

  it('returns isRunning=false and lastRun=null when no runs have occurred', async () => {
    mockGetLastRun.mockImplementation(() => null);

    const req = createReq();
    const { res, jsonSpy } = createRes();

    await (routes as any).handleStatus(req, res);

    const body = jsonSpy.mock.calls[0][0] as any;
    expect(body.isRunning).toBe(false);
    expect(body.lastRun).toBeNull();
  });

  it('returns isRunning=true when cycle is in progress', async () => {
    mockIsRunning.mockImplementation(() => true);
    mockGetLastRun.mockImplementation(() => null);

    const req = createReq();
    const { res, jsonSpy } = createRes();

    await (routes as any).handleStatus(req, res);

    const body = jsonSpy.mock.calls[0][0] as any;
    expect(body.isRunning).toBe(true);
  });

  it('returns parsed report when lastRun has valid JSON report', async () => {
    const reportData = { status: 'completed', phases: {} };
    const row = makeRunRow({ report: JSON.stringify(reportData) });
    mockGetLastRun.mockImplementation(() => row);

    const req = createReq();
    const { res, jsonSpy } = createRes();

    await (routes as any).handleStatus(req, res);

    const body = jsonSpy.mock.calls[0][0] as any;
    expect(body.lastRun).not.toBeNull();
    expect(body.lastRun.id).toBe(1);
    expect(body.lastRun.status).toBe('completed');
    expect(body.lastRun.report).toEqual(reportData);
  });

  it('returns null report when lastRun.report is null', async () => {
    const row = makeRunRow({ report: null });
    mockGetLastRun.mockImplementation(() => row);

    const req = createReq();
    const { res, jsonSpy } = createRes();

    await (routes as any).handleStatus(req, res);

    const body = jsonSpy.mock.calls[0][0] as any;
    expect(body.lastRun.report).toBeNull();
  });

  // BUG EXPOSURE: JSON.parse(lastRun.report) has no try/catch.
  //
  // When the report column contains malformed JSON (e.g. truncated write,
  // schema migration, or manual DB edit), JSON.parse throws a SyntaxError.
  // The wrapHandler does NOT catch this because it only wraps the async
  // function — and JSON.parse is synchronous inside an async fn, so it
  // propagates as an unhandled rejection with no HTTP response sent.
  //
  // Fix: wrap JSON.parse in try/catch and fall back to null or raw string.
  it('TODO(bug): returns graceful response when lastRun.report is malformed JSON', async () => {
    const row = makeRunRow({ report: '{invalid json [[[' });
    mockGetLastRun.mockImplementation(() => row);

    const req = createReq();
    const { res, jsonSpy } = createRes();

    // BUG: currently throws SyntaxError and no response is sent
    // The test expects a graceful response with report=null or raw string
    await (routes as any).handleStatus(req, res);

    // FAILS until bug is fixed (JSON.parse throws → no json() call)
    expect(jsonSpy).toHaveBeenCalled();
    const body = jsonSpy.mock.calls[0][0] as any;
    expect(body.lastRun).not.toBeNull();
    // Should degrade gracefully — report should be null or a safe fallback
    expect(body.lastRun.report).toBeNull();
  });
});
