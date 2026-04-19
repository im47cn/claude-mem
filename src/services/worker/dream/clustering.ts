/**
 * Phase 1: Observation Clustering
 *
 * Groups observations by project, then clusters within each project
 * using keyword overlap (Jaccard similarity). Zero API cost.
 */

import { logger } from '../../../utils/logger.js';
import type { ObservationForClustering, ObservationCluster, ClusterOptions } from './types.js';

const DEFAULT_MIN_SIMILARITY = 0.3;
const DEFAULT_MIN_CLUSTER_SIZE = 3;

/**
 * Extract meaningful keywords from observation text fields
 */
export function extractKeywords(obs: ObservationForClustering): Set<string> {
  const parts: string[] = [];
  if (obs.title) parts.push(obs.title);
  if (obs.subtitle) parts.push(obs.subtitle);
  if (obs.narrative) parts.push(obs.narrative);

  // Parse facts JSON array if present
  if (obs.facts) {
    try {
      const factsArr = JSON.parse(obs.facts);
      if (Array.isArray(factsArr)) parts.push(...factsArr);
    } catch { /* ignore parse errors */ }
  }

  const text = parts.join(' ').toLowerCase();
  // Split on non-alphanumeric, filter short words and stop words
  const words = text.split(/[^a-z0-9]+/).filter(w => w.length > 3);
  return new Set(words.filter(w => !STOP_WORDS.has(w)));
}

/**
 * Jaccard similarity between two keyword sets
 */
export function keywordSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Infer entity type from observation type and content
 */
function inferEntityType(observations: ObservationForClustering[]): ObservationCluster['entityType'] {
  const typeCounts = new Map<string, number>();
  for (const obs of observations) {
    typeCounts.set(obs.type, (typeCounts.get(obs.type) || 0) + 1);
  }

  // Map observation types to entity types
  const dominant = [...typeCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  switch (dominant) {
    case 'decision': return 'decision';
    case 'feature': return 'project';
    case 'discovery': return 'pattern';
    case 'preference': return 'preference';
    case 'change': return 'pattern';
    default: return 'pattern';
  }
}

/**
 * Derive a topic key from a cluster's keywords
 */
function deriveTopic(keywords: string[], project: string | null, entityType: string): string {
  const topWords = keywords.slice(0, 3).join('-');
  const prefix = entityType === 'preference' ? 'preferences'
    : entityType === 'decision' ? 'decisions'
    : entityType === 'project' ? 'projects'
    : entityType === 'tool' ? 'tools'
    : 'patterns';
  return project ? `${project}/${prefix}/${topWords}` : `${prefix}/${topWords}`;
}

/**
 * Cluster observations within a single project using keyword overlap.
 * Uses greedy single-linkage clustering.
 */
export function clusterByKeywordOverlap(
  observations: ObservationForClustering[],
  options: ClusterOptions = {}
): ObservationCluster[] {
  const minSim = options.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  const minSize = options.minClusterSize ?? DEFAULT_MIN_CLUSTER_SIZE;

  if (observations.length < minSize) return [];

  // Extract keywords for each observation
  const keywordSets = observations.map(obs => ({
    obs,
    keywords: extractKeywords(obs),
  }));

  // Greedy clustering: assign each observation to the most similar existing cluster
  const clusters: { members: typeof keywordSets; combinedKeywords: Set<string> }[] = [];

  for (const item of keywordSets) {
    let bestCluster = -1;
    let bestSim = 0;

    for (let i = 0; i < clusters.length; i++) {
      const sim = keywordSimilarity(item.keywords, clusters[i].combinedKeywords);
      if (sim > bestSim && sim >= minSim) {
        bestSim = sim;
        bestCluster = i;
      }
    }

    if (bestCluster >= 0) {
      clusters[bestCluster].members.push(item);
      // Merge keywords into cluster
      for (const kw of item.keywords) {
        clusters[bestCluster].combinedKeywords.add(kw);
      }
    } else {
      // Start new cluster
      clusters.push({
        members: [item],
        combinedKeywords: new Set(item.keywords),
      });
    }
  }

  // Filter by minimum size and build output
  return clusters
    .filter(c => c.members.length >= minSize)
    .map(c => {
      const obs = c.members.map(m => m.obs);
      const project = obs[0].project;

      // Top keywords by frequency
      const kwFreq = new Map<string, number>();
      for (const member of c.members) {
        for (const kw of member.keywords) {
          kwFreq.set(kw, (kwFreq.get(kw) || 0) + 1);
        }
      }
      const topKeywords = [...kwFreq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([kw]) => kw);

      const entityType = inferEntityType(obs);
      const topic = deriveTopic(topKeywords, project, entityType);

      return {
        topic,
        entityType,
        project,
        observations: obs,
        keywords: topKeywords,
      };
    });
}

/**
 * Main Phase 1 entry point: cluster observations by project then keywords
 */
export function clusterObservations(
  observations: ObservationForClustering[],
  options: ClusterOptions = {}
): ObservationCluster[] {
  // Group by project first (cheap, deterministic)
  const byProject = new Map<string, ObservationForClustering[]>();
  for (const obs of observations) {
    const key = obs.project;
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key)!.push(obs);
  }

  // Cluster within each project
  const allClusters: ObservationCluster[] = [];
  for (const [, projectObs] of byProject) {
    const clusters = clusterByKeywordOverlap(projectObs, options);
    allClusters.push(...clusters);
  }

  return allClusters;
}

/** Common English stop words to filter out */
const STOP_WORDS = new Set([
  'this', 'that', 'with', 'from', 'have', 'been', 'were', 'will',
  'would', 'could', 'should', 'which', 'their', 'there', 'about',
  'when', 'what', 'they', 'some', 'other', 'than', 'then', 'also',
  'into', 'more', 'only', 'each', 'such', 'like', 'over', 'after',
  'before', 'between', 'under', 'does', 'done', 'being', 'very',
  'just', 'most', 'both', 'these', 'those', 'same', 'well',
]);
