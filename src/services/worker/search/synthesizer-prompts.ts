/**
 * Prompt templates for the Synthesizer component.
 * Isolated from business logic for easy iteration and testing.
 */

import type { ObservationForClustering } from '../../worker/dream/types.js';

/**
 * System prompt instructs the LLM on synthesis behavior
 */
export function buildSystemPrompt(): string {
  return `You are a knowledge synthesizer. Your job is to read a set of observations about a topic and produce a single, concise summary that captures the current state of knowledge.

Rules:
- REWRITE the summary completely each time. Do not append to previous summaries.
- Every claim must be traceable to the provided observations.
- Be concise: prefer 2-4 sentences over paragraphs.
- Use present tense for current state, past tense for historical context.
- If observations contradict each other, note the contradiction briefly.
- Output ONLY the summary text. No headers, bullet points, or markdown formatting.`;
}

interface UserPromptInput {
  topic: string;
  entityType: string;
  observations: ObservationForClustering[];
  project?: string;
  existingText?: string;
}

/**
 * User prompt provides the observations and context for synthesis
 */
export function buildUserPrompt(input: UserPromptInput): string {
  const { topic, entityType, observations, project, existingText } = input;

  const scope = project ? `Project: ${project}` : 'Scope: Global (cross-project)';

  const obsLines = observations.map(o => {
    const date = new Date(o.created_at_epoch).toISOString().split('T')[0];
    const title = o.title ?? '(untitled)';
    const narrative = o.narrative ?? '';
    const facts = o.facts ? safeParseFacts(o.facts) : '';
    return `- [${o.type}] ${title} (${date})${narrative ? `\n  ${narrative}` : ''}${facts ? `\n  Facts: ${facts}` : ''}`;
  }).join('\n');

  const existingSection = existingText
    ? `\nCurrent summary (REWRITE this using the new evidence above):\n${existingText}`
    : '\nNo existing summary. Create a new one.';

  return `Topic: ${topic}
Entity type: ${entityType}
${scope}

Observations (${observations.length} total):
${obsLines}
${existingSection}

Write a concise summary of the current state of knowledge about this topic.`;
}

/**
 * Safely parse JSON facts string into readable text
 */
function safeParseFacts(factsJson: string): string {
  try {
    const arr = JSON.parse(factsJson);
    return Array.isArray(arr) ? arr.join(', ') : '';
  } catch {
    return factsJson;
  }
}
