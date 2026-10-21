/**
 * "Is this model provider usable right now?" asked before the first real call, so an app can
 * show a setup screen (or `dot doctor` can say what is wrong) instead of failing mid-request.
 */
import { z } from '@arki/contracts';
import { attempt, isFailure } from '@arki/failure';

import type { LLMProviderConfig } from './factory';
import type { LLMProviderName } from './provider-names';
import { debugService } from '../debug';
import { env } from '../env';
import { ProviderUnavailable } from '../failures';
import { resolveLlmModel, resolveLlmProvider, resolveOllamaBaseUrl } from './factory';

/** How long the probe waits for a server that does not answer, in milliseconds. */
export const DEFAULT_PROBE_TIMEOUT_MS = 2000;

export type ProbeOptions = Pick<LLMProviderConfig, 'provider' | 'model' | 'baseURL' | 'apiKey'> & {
  /** Give up on a server that has not answered after this many milliseconds. Default 2000. */
  readonly timeoutMs?: number;
  /** The HTTP client. Tests pass a stub; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
};

/** The provider and model `createLLMProvider` would use with the same config, known to be usable. */
export type ReadyProvider = { readonly provider: LLMProviderName; readonly model: string };

/** The part of Ollama's `GET /api/tags` answer the probe reads. */
const ollamaTagsSchema = z.object({ models: z.array(z.object({ name: z.string() })) });

/** The key variable each cloud provider reads when no `apiKey` is passed. */
const API_KEYS = {
  openai: () => env.OPENAI_API_KEY,
  anthropic: () => env.ANTHROPIC_API_KEY,
  groq: () => env.GROQ_API_KEY,
  google: () => env.GOOGLE_GENERATIVE_AI_API_KEY,
  mistral: () => env.MISTRAL_API_KEY,
} as const satisfies Record<Exclude<LLMProviderName, 'ollama'>, () => string | undefined>;

/** `gemma4` and `gemma4:latest` name the same Ollama model. */
function sameModel(installed: string, wanted: string): boolean {
  return installed === wanted || installed === `${wanted}:latest` || `${installed}:latest` === wanted;
}

/** GET `url`, or `null` when it does not answer 2xx in time. */
async function get(url: string, client: typeof fetch, timeoutMs: number): Promise<Response | null> {
  const response = await attempt(
    () => client(url, { signal: AbortSignal.timeout(timeoutMs) }),
    () => null,
  );
  return response?.ok ? response : null;
}

/**
 * Check that the provider `createLLMProvider(options)` would build can be called. It resolves the
 * provider and model exactly as `createLLMProvider` does (explicit option, then `LLM_PROVIDER` /
 * `LLM_MODEL`, then the default).
 *
 * - **Ollama:** the server answers `GET /api/tags` and lists the model (`name` and `name:latest`
 *   count as the same model).
 * - **OpenAI with `baseURL`** (an OpenAI-compatible server): it answers `GET <baseURL>/models`.
 * - **A cloud provider:** its API key is set (`apiKey`, or the provider's key variable). The key
 *   is not sent anywhere, so a wrong key still passes.
 *
 * It never throws: an unusable provider is the returned `ProviderUnavailable` failure.
 *
 * @example
 * ```ts
 * const ready = await probeLLMProvider();
 * if (ProviderUnavailable.is(ready)) return showSetupScreen(ready.data.problem);
 * const llm = createLLMProvider(ready);
 * ```
 */
export async function probeLLMProvider(options: ProbeOptions = {}): Promise<ReadyProvider | ProviderUnavailable> {
  const provider = resolveLlmProvider(options);
  const model = resolveLlmModel(options);
  const client = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const ready: ReadyProvider = { provider, model };
  const unavailable = (problem: ProviderUnavailable['data']['problem']) =>
    ProviderUnavailable({ provider, model, problem });

  let result: ReadyProvider | ProviderUnavailable;
  if (provider === 'ollama') {
    const response = await get(new URL('/api/tags', resolveOllamaBaseUrl(options)).href, client, timeoutMs);
    const tags =
      response &&
      ollamaTagsSchema.safeParse(
        await attempt(
          () => response.json(),
          () => null,
        ),
      );
    if (tags?.success)
      result = tags.data.models.some(entry => sameModel(entry.name, model)) ? ready : unavailable('model_missing');
    else result = unavailable('unreachable');
  } else if (provider === 'openai' && options.baseURL) {
    const response = await get(`${options.baseURL.replace(/\/$/u, '')}/models`, client, timeoutMs);
    result = response ? ready : unavailable('unreachable');
  } else {
    result = (options.apiKey ?? API_KEYS[provider]()) ? ready : unavailable('missing_key');
  }
  debugService.debug('provider probe {provider}/{model}: {outcome}', {
    provider,
    model,
    outcome: isFailure(result) ? result.data.problem : 'ready',
  });
  return result;
}
