/**
 * LLM Provider abstraction for the Synthesizer.
 * Reuses HTTP call patterns from GeminiAgent and OpenRouterAgent.
 */

import { SettingsDefaultsManager } from '../../../shared/SettingsDefaultsManager.js';
import { getCredential } from '../../../shared/EnvManager.js';
import { USER_SETTINGS_PATH } from '../../../shared/paths.js';
import { logger } from '../../../utils/logger.js';

/**
 * Minimal LLM interface - single completion call, no streaming
 */
export interface LLMProvider {
  readonly name: string;
  complete(systemPrompt: string, userPrompt: string): Promise<string | null>;
}

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

/**
 * Gemini LLM provider - cheapest option, good for batch synthesis
 */
export class GeminiLLMProvider implements LLMProvider {
  readonly name = 'gemini';

  constructor(
    private apiKey: string,
    private model: string = 'gemini-2.5-flash-lite'
  ) {}

  async complete(systemPrompt: string, userPrompt: string): Promise<string | null> {
    const url = `${GEMINI_API_URL}/${this.model}:generateContent?key=${this.apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 1024,
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      logger.warn('SYNTH', `Gemini API error: ${response.status}`, { error });
      return null;
    }

    const data = await response.json() as any;
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
  }
}

/**
 * OpenRouter LLM provider - flexible model selection, many free options
 */
export class OpenRouterLLMProvider implements LLMProvider {
  readonly name = 'openrouter';

  constructor(
    private apiKey: string,
    private model: string = 'xiaomi/mimo-v2-flash:free'
  ) {}

  async complete(systemPrompt: string, userPrompt: string): Promise<string | null> {
    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/thedotmack/claude-mem',
        'X-Title': 'claude-mem',
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 1024,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      logger.warn('SYNTH', `OpenRouter API error: ${response.status}`, { error });
      return null;
    }

    const data = await response.json() as any;
    return data.choices?.[0]?.message?.content ?? null;
  }
}

/**
 * Claude/Anthropic LLM provider - highest quality, most expensive
 */
export class ClaudeLLMProvider implements LLMProvider {
  readonly name = 'claude';

  constructor(
    private apiKey: string,
    private model: string = 'claude-haiku-4-5-20251001'
  ) {}

  async complete(systemPrompt: string, userPrompt: string): Promise<string | null> {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      logger.warn('SYNTH', `Claude API error: ${response.status}`, { error });
      return null;
    }

    const data = await response.json() as any;
    return data.content?.[0]?.text ?? null;
  }
}

/**
 * Create an LLM provider based on user's configured settings.
 * Falls back gracefully: tries configured provider, then Gemini, then OpenRouter.
 */
export function createLLMProvider(): LLMProvider | null {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  const provider = settings.CLAUDE_MEM_PROVIDER || 'gemini';

  switch (provider) {
    case 'gemini': {
      const apiKey = settings.CLAUDE_MEM_GEMINI_API_KEY
        || getCredential('GEMINI_API_KEY')
        || process.env.GEMINI_API_KEY
        || '';
      if (!apiKey) {
        logger.info('SYNTH', 'No Gemini API key configured, synthesizer unavailable');
        return null;
      }
      const model = settings.CLAUDE_MEM_GEMINI_MODEL || 'gemini-2.5-flash-lite';
      return new GeminiLLMProvider(apiKey, model);
    }

    case 'openrouter': {
      const apiKey = settings.CLAUDE_MEM_OPENROUTER_API_KEY
        || getCredential('OPENROUTER_API_KEY')
        || process.env.OPENROUTER_API_KEY
        || '';
      if (!apiKey) {
        logger.info('SYNTH', 'No OpenRouter API key configured, synthesizer unavailable');
        return null;
      }
      const model = settings.CLAUDE_MEM_OPENROUTER_MODEL || 'xiaomi/mimo-v2-flash:free';
      return new OpenRouterLLMProvider(apiKey, model);
    }

    case 'claude': {
      // Resolution order:
      // 1. Explicit claude-mem settings key (highest priority, user-intentional)
      // 2. ~/.claude-mem/.env managed credential
      // 3. process.env.ANTHROPIC_API_KEY — available in the Worker process itself
      //    (BLOCKED_ENV_VARS only strips this from spawned subprocesses, not the worker)
      const apiKey = settings.CLAUDE_MEM_ANTHROPIC_API_KEY
        || getCredential('ANTHROPIC_API_KEY')
        || process.env.ANTHROPIC_API_KEY
        || '';
      if (!apiKey) {
        logger.info('SYNTH', 'No Anthropic API key configured, synthesizer unavailable');
        return null;
      }
      const model = settings.CLAUDE_MEM_MODEL || 'claude-haiku-4-5-20251001';
      return new ClaudeLLMProvider(apiKey, model);
    }

    default: {
      logger.warn('SYNTH', `Unknown provider "${provider}", trying Gemini fallback`);
      const apiKey = settings.CLAUDE_MEM_GEMINI_API_KEY
        || getCredential('GEMINI_API_KEY')
        || process.env.GEMINI_API_KEY
        || '';
      if (!apiKey) return null;
      return new GeminiLLMProvider(apiKey);
    }
  }
}
