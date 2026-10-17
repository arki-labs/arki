/**
 * `@arki/testing/services/ollama` — the Ollama daemon already running on this machine. Host only:
 * a test never pulls a model and never starts the daemon. A missing daemon or model fails the run
 * with the command that fixes it, never a skip.
 */
import { service } from '../stack/index.js';
import { nothingToStop } from './labels.js';

export type OllamaValue = { readonly url: string; readonly models: readonly string[] };

export type OllamaOptions = {
  /** Default `http://127.0.0.1:11434`. */
  readonly url?: string;
  /** Models the run needs, for example `qwen3:0.6b`. */
  readonly models: readonly string[];
};

type TagsAnswer = { readonly models?: readonly { readonly name?: string }[] };

export const ollama = (options: OllamaOptions) =>
  service<OllamaValue>({
    name: 'ollama',
    scope: 'run',
    async start() {
      const url = options.url ?? 'http://127.0.0.1:11434';
      let installed: readonly string[];
      try {
        const response = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) });
        // Erasure seam: /api/tags has a fixed shape; only `models[].name` is read, defensively.
        const answer = (await response.json()) as TagsAnswer;
        installed = (answer.models ?? []).flatMap(model => (model.name === undefined ? [] : [model.name]));
      } catch (error) {
        throw new Error(`OLLAMA_NOT_RUNNING: nothing answered at ${url}. Start it with \`ollama serve\`.`, { cause: error });
      }
      const missing = options.models.filter(model => !installed.includes(model));
      if (missing.length > 0) {
        throw new Error(`OLLAMA_MODEL_MISSING: ${missing.join(', ')}. Pull with ${missing.map(model => `\`ollama pull ${model}\``).join(' and ')}.`);
      }
      return { value: { url, models: options.models }, stop: nothingToStop };
    },
  });
