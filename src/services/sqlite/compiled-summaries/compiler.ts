/**
 * Compiled Truth Compiler
 *
 * Clusters related observations and generates compiled summaries using AI.
 * Implements the GBrain Compiled Truth + Timeline pattern:
 * - Groups observations by semantic similarity (topic clustering)
 * - Generates/rewrites compiled summaries for each cluster
 * - Maintains traceability via observation_ids
 *
 * Compilation triggers:
 * 1. Threshold-based: 5+ observations share a topic cluster
 * 2. Time-based: Periodic sweep (called by dream cycle or cron)
 * 3. On-demand: Manual compilation request
 */

import { Database } from 'bun:sqlite';
import { logger } from '../../../utils/logger.js';
import type { ObservationRow, CompiledSummaryRow, CompiledSummaryEntityType } from '../types.js';
import { createCompiledSummary, rewriteCompiledSummary } from './store.js';
import { getCompiledSummaryByTopic } from './get.js';

/** Minimum observations needed to trigger compilation */
const COMPILATION_THRESHOLD = 5;

/** Maximum observations to include in a single compilation */
const MAX_OBSERVATIONS_PER_COMPILATION = 50;

/**
 * Result of a compilation run
 */
export interface CompilationResult {
  created: number;
  updated: number;
  skipped: number;
  errors: number;
  topics: string[];
}

/**
 * A cluster of related observations ready for compilation
 */
export interface ObservationCluster {
  topic: string;
  entityType: CompiledSummaryEntityType;
  observations: ObservationRow[];
  existing?: CompiledSummaryRow;
}

/**
 * Function type for AI synthesis (injectable for testing)
 */
export type SynthesisFunction = (
  topic: string,
  observations: ObservationRow[],
  existingText?: string
) => Promise<string>;

/**
 * Cluster observations by their concepts and types.
 * Groups related observations that share concepts or files.
 */
export function clusterObservations(
  db: Database,
  options: { project?: string; limit?: number } = {}
): ObservationCluster[] {
  const { project, limit = 500 } = options;

  // Get recent observations that might need compilation
  const params: any[] = [];
  const conditions: string[] = [];

  if (project) {
    conditions.push('(project = ? OR project IS NULL)');
    params.push(project);
  }

  // Only look at observations with concepts (they are more structured)
  conditions.push("concepts IS NOT NULL AND concepts != '[]'");

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit);

  const observations = db.prepare(`
    SELECT * FROM observations
    ${where}
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `).all(...params) as ObservationRow[];

  // Group by concept clusters
  const conceptGroups = new Map<string, ObservationRow[]>();

  for (const obs of observations) {
    const concepts = parseConcepts(obs.concepts);
    if (concepts.length === 0) continue;

    // Use the first/primary concept as the grouping key
    // Normalize to lowercase for consistent grouping
    const primaryConcept = concepts[0].toLowerCase().trim();
    if (!primaryConcept) continue;

    if (!conceptGroups.has(primaryConcept)) {
      conceptGroups.set(primaryConcept, []);
    }
    conceptGroups.get(primaryConcept)!.push(obs);
  }

  // Also group by type for broader clusters
  const typeGroups = new Map<string, ObservationRow[]>();
  for (const obs of observations) {
    if (!typeGroups.has(obs.type)) {
      typeGroups.set(obs.type, []);
    }
    typeGroups.get(obs.type)!.push(obs);
  }

  // Build clusters from concept groups that meet threshold
  const clusters: ObservationCluster[] = [];

  for (const [concept, obs] of conceptGroups) {
    if (obs.length < COMPILATION_THRESHOLD) continue;

    const limitedObs = obs.slice(0, MAX_OBSERVATIONS_PER_COMPILATION);
    const entityType = inferEntityType(concept, limitedObs);
    const existing = getCompiledSummaryByTopic(db, concept, project);

    clusters.push({
      topic: concept,
      entityType,
      observations: limitedObs,
      existing: existing ?? undefined
    });
  }

  return clusters;
}

/**
 * Run compilation for all eligible clusters.
 * Uses the provided synthesis function for AI-powered text generation.
 */
export async function compileAll(
  db: Database,
  synthesize: SynthesisFunction,
  options: { project?: string } = {}
): Promise<CompilationResult> {
  const result: CompilationResult = {
    created: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    topics: []
  };

  const clusters = clusterObservations(db, options);

  for (const cluster of clusters) {
    try {
      const observationIds = cluster.observations.map(o => o.id);

      if (cluster.existing) {
        // Check if we have new observations since last compilation
        const existingIds = new Set(parseObservationIds(cluster.existing.observation_ids));
        const newIds = observationIds.filter(id => !existingIds.has(id));

        if (newIds.length === 0 && !cluster.existing.is_stale) {
          result.skipped++;
          continue;
        }

        // REWRITE the compiled summary with all observations
        const compiledText = await synthesize(
          cluster.topic,
          cluster.observations,
          cluster.existing.compiled_text
        );

        const allIds = [...new Set([...existingIds, ...observationIds])];
        const confidence = computeConfidence(allIds.length);

        rewriteCompiledSummary(db, cluster.existing.id, compiledText, allIds, confidence);
        result.updated++;
      } else {
        // Create new compiled summary
        const compiledText = await synthesize(
          cluster.topic,
          cluster.observations
        );

        const confidence = computeConfidence(observationIds.length);

        createCompiledSummary(db, {
          topic: cluster.topic,
          entity_type: cluster.entityType,
          compiled_text: compiledText,
          confidence,
          observation_ids: observationIds,
          project: options.project
        });

        result.created++;
      }

      result.topics.push(cluster.topic);
    } catch (error) {
      logger.error('COMPILED', `Failed to compile topic="${cluster.topic}"`, {}, error as Error);
      result.errors++;
    }
  }

  logger.info('COMPILED', `Compilation complete: created=${result.created} updated=${result.updated} skipped=${result.skipped} errors=${result.errors}`);
  return result;
}

/**
 * Generate a default synthesis prompt for the AI agent.
 * This is used when no custom synthesis function is provided.
 */
export function buildSynthesisPrompt(
  topic: string,
  observations: ObservationRow[],
  existingText?: string
): string {
  const obsLines = observations.map(o => {
    const date = o.created_at?.slice(0, 10) || 'unknown';
    const title = o.title || 'Untitled';
    const narrative = o.narrative || o.text || '';
    return `- [${date}] ${title}: ${narrative}`;
  }).join('\n');

  const existingSection = existingText
    ? `\nCurrent compiled summary:\n${existingText}\n`
    : '';

  return `Given these observations about "${topic}":
${obsLines}
${existingSection}
Write a concise, current-state summary that synthesizes all observations into a coherent understanding.

Rules:
- REWRITE completely — do not append to the existing summary
- Every claim must be traceable to the observations above
- Focus on the current state of affairs, not history
- Be concise: aim for 2-5 sentences
- Use present tense for current facts
- Note any contradictions or evolution in understanding`;
}

/**
 * Simple local synthesis (no AI) — used for testing or when AI is unavailable.
 * Concatenates observation titles and narratives into a summary.
 */
export function localSynthesize(
  topic: string,
  observations: ObservationRow[],
  _existingText?: string
): string {
  const uniqueTitles = [...new Set(observations.map(o => o.title).filter(Boolean))];
  const latestNarrative = observations
    .filter(o => o.narrative)
    .sort((a, b) => b.created_at_epoch - a.created_at_epoch)[0]?.narrative;

  const parts: string[] = [];

  if (uniqueTitles.length > 0) {
    parts.push(`Key observations about "${topic}": ${uniqueTitles.join('; ')}.`);
  }

  if (latestNarrative) {
    parts.push(`Latest context: ${latestNarrative}`);
  }

  parts.push(`Based on ${observations.length} observations spanning ${getDateRange(observations)}.`);

  return parts.join(' ');
}

// --- Helper functions ---

function parseConcepts(conceptsJson: string | null): string[] {
  if (!conceptsJson) return [];
  try {
    const parsed = JSON.parse(conceptsJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseObservationIds(idsJson: string): number[] {
  try {
    const parsed = JSON.parse(idsJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function inferEntityType(topic: string, observations: ObservationRow[]): CompiledSummaryEntityType {
  const topicLower = topic.toLowerCase();

  if (topicLower.includes('prefer') || topicLower.includes('config') || topicLower.includes('setting')) {
    return 'preference';
  }
  if (topicLower.includes('pattern') || topicLower.includes('convention') || topicLower.includes('style')) {
    return 'pattern';
  }
  if (topicLower.includes('architect') || topicLower.includes('design') || topicLower.includes('structure')) {
    return 'architecture';
  }
  if (topicLower.includes('tool') || topicLower.includes('framework') || topicLower.includes('library')) {
    return 'tool';
  }
  if (topicLower.includes('workflow') || topicLower.includes('process') || topicLower.includes('pipeline')) {
    return 'workflow';
  }

  // Check observation types
  const typeFreq = new Map<string, number>();
  for (const obs of observations) {
    typeFreq.set(obs.type, (typeFreq.get(obs.type) || 0) + 1);
  }
  const dominantType = [...typeFreq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  if (dominantType === 'decision') return 'decision';
  if (dominantType === 'feature' || dominantType === 'refactor') return 'project';

  return 'general';
}

function computeConfidence(observationCount: number): number {
  // Confidence scales with evidence count, capped at 0.95
  if (observationCount <= 1) return 0.5;
  if (observationCount <= 3) return 0.6;
  if (observationCount <= 5) return 0.7;
  if (observationCount <= 10) return 0.8;
  if (observationCount <= 20) return 0.9;
  return 0.95;
}

function getDateRange(observations: ObservationRow[]): string {
  if (observations.length === 0) return 'no period';
  const sorted = [...observations].sort((a, b) => a.created_at_epoch - b.created_at_epoch);
  const first = sorted[0].created_at?.slice(0, 10) || 'unknown';
  const last = sorted[sorted.length - 1].created_at?.slice(0, 10) || 'unknown';
  return first === last ? first : `${first} to ${last}`;
}
