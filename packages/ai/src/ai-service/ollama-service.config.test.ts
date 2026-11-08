/**
 * OllamaService settings are checked when the service is built, and only its own. WHY it matters: a bad host
 * once threw a raw TypeError from the Ollama library, and any bad `@arki/ai` variable it never reads (even
 * `QDRANT_URL`) stopped a local model from starting.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigurationError } from '../errors';
import { OllamaService } from './ollama-service';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('OllamaService configuration (audit-2 noticed)', () => {
  it.each(['not a url', 'http://', 'localhost:11434', 'ftp://localhost:11434'])(
    'a host of %j throws ConfigurationError when built',
    host => {
      expect(() => new OllamaService({ host })).toThrow(
        expect.objectContaining({
          name: 'ConfigurationError',
          code: 'CONFIGURATION_ERROR',
          message: `Ollama host "${host}" is not an http or https URL. Fix \`host\`, OLLAMA_HOST or OLLAMA_BASE_URL, e.g. http://localhost:11434.`,
        }),
      );
    },
  );

  it('a bad OLLAMA_HOST throws ConfigurationError when built', () => {
    vi.stubEnv('OLLAMA_HOST', 'not a url');
    expect(() => new OllamaService()).toThrow(ConfigurationError);
  });

  it('a bad variable it does not read (QDRANT_URL) does not stop it', () => {
    vi.stubEnv('QDRANT_URL', 'not a url');
    expect(new OllamaService({ host: 'http://localhost:11434' }).name).toBe('ollama');
  });

  it('a bad AI_DETERMINISTIC_SEED, its own setting, throws ConfigurationError when built', () => {
    vi.stubEnv('AI_DETERMINISTIC_SEED', 'abc');
    expect(() => new OllamaService({ host: 'http://localhost:11434' })).toThrow(
      expect.objectContaining({
        name: 'ConfigurationError',
        message: 'AI_DETERMINISTIC_SEED must be a whole number, got "abc".',
      }),
    );
  });

  it('accepts an http or https host, with or without the /v1 suffix', () => {
    for (const host of ['http://localhost:11434', 'https://ollama.example.com/v1'])
      expect(new OllamaService({ host }).name).toBe('ollama');
  });
});
