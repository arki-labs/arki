/**
 * `probeLLMProvider`: an app asks "can I call the model?" before it calls, and gets a typed
 * answer it can branch on (setup screen, `dot doctor` issue) instead of a throw mid-request.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProviderUnavailable } from '../failures';
import { probeLLMProvider } from './probe';

/** A `fetch` that answers every request with `body` (JSON) and `status`. */
function answering(body: unknown, status = 200): typeof fetch {
  return vi.fn<typeof fetch>(() => Promise.resolve(Response.json(body, { status })));
}

const tags = (...names: string[]) => ({ models: names.map(name => ({ name })) });

describe('probeLLMProvider', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is ready when Ollama answers and lists the model, `:latest` or not', async () => {
    // WHY: `ollama pull gemma4` installs `gemma4:latest`; asking for either name must not report
    // the model as missing.
    const fetch = answering(tags('gemma4:latest', 'qwen3.6:latest'));

    await expect(
      probeLLMProvider({ provider: 'ollama', model: 'gemma4', baseURL: 'http://ollama.test:11434/v1', fetch }),
    ).resolves.toEqual({
      provider: 'ollama',
      model: 'gemma4',
    });
    await expect(probeLLMProvider({ provider: 'ollama', model: 'qwen3.6:latest', fetch })).resolves.toEqual({
      provider: 'ollama',
      model: 'qwen3.6:latest',
    });
    // The OpenAI-style `/v1` suffix is dropped: the probe asks Ollama's native API, as the provider does.
    expect(fetch).toHaveBeenCalledWith('http://ollama.test:11434/api/tags', expect.anything());
  });

  it('says model_missing when Ollama runs without the model', async () => {
    // WHY: "start Ollama" and "pull the model" are different fixes; the app must say which.
    const result = await probeLLMProvider({ provider: 'ollama', model: 'gemma4', fetch: answering(tags('llama3')) });

    expect(ProviderUnavailable.is(result) && result.data).toEqual({
      provider: 'ollama',
      model: 'gemma4',
      problem: 'model_missing',
    });
  });

  it('says unreachable, without throwing, when Ollama is down or answers garbage', async () => {
    // WHY: a probe that throws is just another crash; the caller must get a value to branch on.
    const down = vi.fn<typeof fetch>(() => Promise.reject(new TypeError('fetch failed')));

    for (const fetch of [down, answering({ error: 'boom' }, 500), answering({ unexpected: true })]) {
      const result = await probeLLMProvider({ provider: 'ollama', model: 'gemma4', fetch });
      expect(ProviderUnavailable.is(result) && result.data.problem).toBe('unreachable');
    }
  });

  it('says unreachable, without throwing or calling fetch, when the Ollama base URL is not a URL', async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    const result = await probeLLMProvider({ provider: 'ollama', model: 'gemma4', baseURL: 'not a url', fetch: fetchSpy });
    expect(ProviderUnavailable.is(result) && result.data.problem).toBe('unreachable');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('checks a cloud provider by its key, without a network call', async () => {
    // WHY: a probe must be cheap and must not spend tokens; a key that is not set is the common
    // misconfiguration.
    const fetch = answering({});
    vi.stubEnv('OPENAI_API_KEY', '');

    const missing = await probeLLMProvider({ provider: 'openai', model: 'gpt-4o-mini', fetch });
    const given = await probeLLMProvider({
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      apiKey: 'sk-test',
      fetch,
    });

    expect(ProviderUnavailable.is(missing) && missing.data.problem).toBe('missing_key');
    expect(given).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5-5' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('pings an OpenAI-compatible baseURL instead of asking for a key', async () => {
    // WHY: a local vLLM or LM Studio server needs no key, so only "does it answer" says anything.
    const fetch = answering({ data: [] });

    await expect(
      probeLLMProvider({ provider: 'openai', model: 'local', baseURL: 'http://vllm.test/v1/', fetch }),
    ).resolves.toEqual({ provider: 'openai', model: 'local' });
    expect(fetch).toHaveBeenCalledWith('http://vllm.test/v1/models', expect.anything());
  });
});
