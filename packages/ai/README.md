# @arki/ai

Local-first AI for TypeScript apps. One provider setting picks Ollama (the default), OpenAI or another cloud model. You get structured generation, embeddings, a vector index that honours erasure, a tool-loop runtime with checked tool output, and an in-memory flow runner. Expected refusals such as a rate limit come back as values, not throws.

## Install

```sh
bun add @arki/ai @arki/failure
```

`@arki/failure` gives you `isFailure`. Everything heavy is an optional peer: install `@arki/dot` for `@arki/ai/dot`, `drizzle-orm` and `@arki/db` for `@arki/ai/drizzle`, `react` and `@ai-sdk/react` for `@arki/ai/react`.

To run a model on your machine, install [Ollama](https://ollama.com) and pull the default model: `ollama pull qwen3.6`.

## Quick start

Pick what the app will call. Nothing leaves your machine until you call a model, and the embedding choice is a pure function of the environment map you pass in.

```ts from="examples/pick-provider.ts#pick-provider"
/** What the app will call, given an environment map. Nothing is sent over the network. */
export function describeSetup(environment: Readonly<Record<string, string | undefined>>) {
  return {
    // `LLM_PROVIDER` and `LLM_MODEL` come from the process environment; ollama is the default.
    chatModel: resolveLlmModel(),
    // The embedding choice is pure: pass the map in. `null` means nothing is configured.
    embeddings: resolveEmbeddingSelection(environment),
  };
}
```

With Ollama configured, the embedding selection is:

```ts run expect
import { resolveEmbeddingSelection } from '@arki/ai';

console.log(resolveEmbeddingSelection({ OLLAMA_BASE_URL: 'http://127.0.0.1:11434' }));
```

```text
{
  type: "ollama",
  model: "qwen3-embedding:0.6b",
  dimensions: 1024,
}
```

Next: [Set up AI](docs/recipes/set-up-ai.md) takes you from nothing to a first model call.

## When not to use this

- You only need one provider's SDK and will never change it. Use that SDK (or the AI SDK, `ai`) directly.
- You need work that survives a restart or waits for hours. `createFlow` runs in memory. Use an `@arki/journal` workflow.
- You need browser or Hermes support for the server entries. They import `node:crypto` and Node clients.
- You want a hosted agent platform with memory and evals. This package adapts the tool loop only.

## Runtime support

Node (the workspace tests on Node 26) and Bun. The root and the server entries (`/cost`, `/safety`, `/dot`, `/drizzle`, `/testing`) are source-distributed TypeScript: your bundler or runtime compiles them. Only `@arki/ai/react` targets the browser. Qdrant, the default durable vector store, imports `node:crypto`, so the vector index is not cross-runtime.

## Public imports

| Import | What it is |
| --- | --- |
| `@arki/ai` | Providers and services (`OllamaService`, `OpenAIService`, `AnthropicService` and more), `createLLMProvider` (its `...Result` methods return token usage), `probeLLMProvider`, embeddings, vector index, semantic search, the tool-loop runtime, `createFlow`, failures and errors. |
| `@arki/ai/cost` | Budgets, a circuit breaker and cost estimates. `priceOf` prices one call and says how (`local`, `list-price` or `default-rate`). |
| `@arki/ai/safety` | Prompt-injection checks, PII redaction, output filtering. |
| `@arki/ai/dot` | `vectorIndex` and `llm` plugins for a Dot app. `llm` checks the provider at boot. |
| `@arki/ai/testing` | `createFakeLLMProvider`: scripted answers and usage, no HTTP. For tests. |
| `@arki/ai/drizzle` | The erasure tombstone table and outbox. |
| `@arki/ai/react` | Chat, streaming text and search components and hooks. |

`llms.txt` lists every export. The package also exposes a `./*` subpath pattern for files under `src/`; treat those as unstable.

## Use it

Check the provider, call it, and read what the call used. In a test, the fake provider stands in for the model:

```ts run expect
import { z } from 'zod';

import { calculateLLMCost } from '@arki/ai';
import { createFakeLLMProvider } from '@arki/ai/testing';

const llm = createFakeLLMProvider({ answers: [{ planet: 'Mars' }], usage: { inputTokens: 12, outputTokens: 4 } });
const answer = await llm.generateStructuredResult('Name one planet.', z.object({ planet: z.string() }));
const { inputTokens = 0, outputTokens = 0 } = answer.usage;
const usd = calculateLLMCost('gemma4:latest', inputTokens, outputTokens, { provider: 'ollama' });

console.log(JSON.stringify({ value: answer.value, usage: answer.usage, usd }));
```

```text
{"value":{"planet":"Mars"},"usage":{"inputTokens":12,"outputTokens":4},"usd":0}
```

In the app, ask before the first call. `probeLLMProvider()` never throws:

```ts skip="needs a running Ollama"
import { createLLMProvider, probeLLMProvider, ProviderUnavailable } from '@arki/ai';

const ready = await probeLLMProvider();
if (ProviderUnavailable.is(ready)) console.log(`not ready: ${ready.data.problem}`);
else console.log(await createLLMProvider(ready).generateText('Say hi.'));
```

The long guides are in [the reference](docs/reference.md): [text and structured generation](docs/reference.md#generate-text-and-structured-data), [embeddings and the vector index](docs/reference.md#embeddings-and-the-vector-index), [the tool loop](docs/reference.md#the-tool-loop), [flows](docs/reference.md#flows) and [React](docs/reference.md#react).

A flow in memory:

```ts from="examples/draft-story.ts#draft-story"
type StoryState = { outline?: string; draft?: string };

type StoryContext = {
  /** Calls a model. A test passes a plain function instead. */
  write: (instruction: string) => Promise<string>;
};

/** Two steps in memory: outline, then draft. A restart loses a run that is in flight. */
const draftStory = createFlow<StoryState, StoryContext>({
  start: 'outline',
  nodes: {
    outline: {
      id: 'outline',
      run: async (_state, context) => ({ outline: await context.write('Outline a short story.') }),
      next: 'draft',
    },
    draft: {
      id: 'draft',
      run: async (state, context) => ({ draft: await context.write(`Write it from: ${state.outline ?? ''}`) }),
      next: undefined,
    },
  },
});
```

## Failure behaviour

| Result | When | What to do |
| --- | --- | --- |
| `RateLimited` (returned, code `ai.rate_limited`, status 429, data `{ retryAfterMs }`) | The local limiter has no free slot. | Wait `retryAfterMs`, then retry. |
| `BudgetExceeded` (returned, code `ai.budget_exceeded`, status 402) | The estimated cost passes the budget of one period. | Wait for the period to reset, or raise the limit. |
| `ProviderUnavailable` (returned by `probeLLMProvider`, code `ai.provider_unavailable`, status 503, data `{ provider, model, problem }`) | `problem` is `unreachable` (Ollama or the `baseURL` server does not answer), `model_missing` (Ollama runs without the model) or `missing_key`. The `llm` Dot plugin fails boot with it. | Start Ollama and `ollama pull` the model, or set the provider's key. |
| `ConfigurationError` (thrown) | A key, model or variable is missing or wrong. | Set what the message names. |
| `GenerationError`, `EmbeddingError`, `VectorSearchError` (thrown) | The provider or the store is down or refused. | Read `cause`. Retry later. |
| `ToolOutputError` (thrown, code `TOOL_OUTPUT_ERROR`) | A tool result did not match its `output` schema. The run emits `tool:error`. | Fix the tool's `execute`. |
| A failure a tool returns | An expected outcome of that tool. | Nothing: the model reads the remediation and tries again. The run emits `tool:failure`. |

Check a returned value with `isFailure` from `@arki/failure`, or a definition's `is`: `RateLimited.is(result)`.

## Limits

- **The package will be split.** It will become the seven packages named in `docs/arki/research/12-ai-split/naming.md` in later minor releases. Import paths may move; each release notes the move in `CHANGELOG.md`.
- **Not cross-runtime.** Qdrant imports `node:crypto`. Do not import `@arki/ai`'s server entries in a browser bundle.
- **Flow is not durable.** `createFlow` loses a run on restart. A run that waits for hours belongs in an `@arki/journal` workflow.
- **Rate-limit check comes first.** `streamText` takes a limiter slot before it returns the stream. Check for `RateLimited` before you iterate: a `RateLimited` value is not a stream.
- **Reconciliation is capped per run.** `runVectorReconciliation` handles at most `ROW_CAP_PER_RUN` (50) rows and `TOMBSTONE_CAP_PER_RUN` (200) tombstones per call. With 10 000 pending tombstones you need 50 calls (cron runs) to clear them.
- **Only a durable index acknowledges erasure.** With no `QDRANT_URL` the index is in memory (`durable: false`), and tombstones stay pending.
- **Spans record prompts.** Generation calls report `gen_ai` spans, prompts and completions included, whenever an OpenTelemetry tracer provider is registered. `AI_TELEMETRY=off` turns them off.
- **The probe does not test a key.** `probeLLMProvider` checks that a cloud key is set, not that the provider accepts it. A wrong key still fails at the first call.
- **Usage can be missing.** `usage.inputTokens` and `usage.outputTokens` are `undefined` when the provider does not report them. Do not read that as zero.
- **The fake is not a model.** `createFakeLLMProvider` answers from a script. A test of what a model would reason passes or fails for the wrong reason.
- **Small local models fail more often on structured output.** Ollama's constrained decoding keeps output on the schema; a model that is too small still gives weak content.
- **`@mastra/core` is pinned** to `1.37.1` as an optional peer. Other versions are untested.

## Documentation

- [Set up AI](docs/recipes/set-up-ai.md)
- [Reference](docs/reference.md)
- [Agent guide](docs/agent-guide.md)
- [Changelog](CHANGELOG.md)

## Support

Report bugs and ask questions on the [Arki issue tracker](https://github.com/arki-labs/arki/issues). Include the package version, your `LLM_PROVIDER`, and the error code.

## License

MIT
