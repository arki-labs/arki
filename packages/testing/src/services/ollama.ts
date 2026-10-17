/**
 * `@arki/testing/services/ollama` — the Ollama daemon already running on this machine. Host only:
 * a test never pulls a model and never starts the daemon. A missing daemon or model fails the run
 * with the command that fixes it, never a skip. The value reports each model's digest, so a report
 * can say exactly which weights answered, and a judge can be refused when it is the model under test.
 */
import { service } from '../stack/index.js';
import { nothingToStop } from './labels.js';

export type OllamaValue = {
  readonly url: string;
  /** Every model the run asked for, `judge` and `embedding` included. */
  readonly models: readonly string[];
  /** The judge model, or `null` when the run asked for none. */
  readonly judge: string | null;
  /** The embedding model, or `null` when the run asked for none. */
  readonly embedding: string | null;
  /** Model name to digest, for every model the run asked for. */
  readonly digests: Readonly<Record<string, string>>;
};

export type OllamaOptions = {
  /** Default `http://127.0.0.1:11434`. */
  readonly url?: string;
  /** Models the run needs, for example `qwen3:0.6b`. */
  readonly models?: readonly string[];
  /** The model that judges AI output. Checked like `models`. */
  readonly judge?: string;
  /** The model that embeds text for `similarTo`. Checked like `models`. */
  readonly embedding?: string;
};

type TagsAnswer = { readonly models?: readonly { readonly name?: string; readonly digest?: string }[] };

export const ollama = (options: OllamaOptions) =>
  service<OllamaValue>({
    name: 'ollama',
    scope: 'run',
    async start() {
      const url = options.url ?? 'http://127.0.0.1:11434';
      const asked = [
        ...new Set([
          ...(options.models ?? []),
          ...(options.judge === undefined ? [] : [options.judge]),
          ...(options.embedding === undefined ? [] : [options.embedding]),
        ]),
      ];
      const installed = new Map<string, string>();
      try {
        const response = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) });
        // Erasure seam: /api/tags has a fixed shape; only `models[].name` and `.digest` are read, defensively.
        const answer = (await response.json()) as TagsAnswer;
        for (const model of answer.models ?? []) {
          if (model.name !== undefined) installed.set(model.name, model.digest ?? '');
        }
      } catch (error) {
        throw new Error(`OLLAMA_NOT_RUNNING: nothing answered at ${url}. Start it with \`ollama serve\`.`, {
          cause: error,
        });
      }
      const missing = asked.filter(model => !installed.has(model));
      if (missing.length > 0) {
        throw new Error(
          `OLLAMA_MODEL_MISSING: ${missing.join(', ')}. Pull with ${missing.map(model => `\`ollama pull ${model}\``).join(' and ')}.`,
        );
      }
      const digests = Object.fromEntries(asked.map(model => [model, installed.get(model) ?? '']));
      return {
        value: { url, models: asked, judge: options.judge ?? null, embedding: options.embedding ?? null, digests },
        stop: nothingToStop,
      };
    },
  });
