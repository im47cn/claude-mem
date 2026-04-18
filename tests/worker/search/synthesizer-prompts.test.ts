import { describe, it, expect } from 'bun:test';
import {
  buildSystemPrompt,
  buildUserPrompt,
} from '../../../src/services/worker/search/synthesizer-prompts.js';
import type { ObservationForClustering } from '../../../src/services/worker/dream/types.js';

function makeObs(overrides: Partial<ObservationForClustering> = {}): ObservationForClustering {
  return {
    id: 1,
    memory_session_id: 'sess-1',
    project: 'test-project',
    title: 'Test Title',
    subtitle: 'Test Subtitle',
    narrative: 'Test narrative content',
    facts: '["fact1","fact2"]',
    concepts: '["concept1"]',
    type: 'discovery',
    created_at_epoch: 1713340800000,
    ...overrides,
  };
}

describe('buildSystemPrompt', () => {
  it('returns a non-empty string with synthesis instructions', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('REWRITE');
    expect(prompt).toContain('traceable');
    expect(prompt.length).toBeGreaterThan(100);
  });
});

describe('buildUserPrompt', () => {
  it('builds prompt with topic and observations', () => {
    const prompt = buildUserPrompt({
      topic: 'user-preferences/runtime',
      entityType: 'preference',
      observations: [makeObs({ title: 'Bun runtime preferred' })],
    });
    expect(prompt).toContain('user-preferences/runtime');
    expect(prompt).toContain('preference');
    expect(prompt).toContain('Bun runtime preferred');
  });

  it('includes project when provided', () => {
    const prompt = buildUserPrompt({
      topic: 'test/topic',
      entityType: 'pattern',
      observations: [makeObs()],
      project: 'my-project',
    });
    expect(prompt).toContain('my-project');
  });

  it('includes existing summary for REWRITE', () => {
    const prompt = buildUserPrompt({
      topic: 'test/topic',
      entityType: 'decision',
      observations: [makeObs()],
      existingText: 'Old summary that should be rewritten.',
    });
    expect(prompt).toContain('Old summary that should be rewritten.');
    expect(prompt).toContain('REWRITE');
  });

  it('handles CREATE mode when no existing summary', () => {
    const prompt = buildUserPrompt({
      topic: 'test/topic',
      entityType: 'tool',
      observations: [makeObs()],
    });
    expect(prompt).toContain('Create a new');
    expect(prompt).not.toContain('Current summary');
  });

  it('handles observations with null fields gracefully', () => {
    const prompt = buildUserPrompt({
      topic: 'test/topic',
      entityType: 'pattern',
      observations: [makeObs({ title: null, narrative: null, facts: null })],
    });
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });

  it('formats multiple observations', () => {
    const prompt = buildUserPrompt({
      topic: 'test/multi',
      entityType: 'pattern',
      observations: [
        makeObs({ id: 1, title: 'First observation' }),
        makeObs({ id: 2, title: 'Second observation' }),
        makeObs({ id: 3, title: 'Third observation' }),
      ],
    });
    expect(prompt).toContain('First observation');
    expect(prompt).toContain('Second observation');
    expect(prompt).toContain('Third observation');
    expect(prompt).toContain('3 total');
  });
});
