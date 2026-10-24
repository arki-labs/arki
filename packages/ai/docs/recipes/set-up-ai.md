# Set up AI

Goal: call a model from your app with Ollama on your machine, then switch to OpenAI by changing one variable.

## 1. Run Ollama (the default)

With `LLM_PROVIDER` unset, `@arki/ai` uses Ollama at `http://127.0.0.1:11434` and the model `qwen3.6:latest`. No key and no cost.

```sh
ollama pull qwen3.6
```

Set `LLM_MODEL` to use another model. Set `OLLAMA_BASE_URL` if Ollama is not on the default address.

## 2. Make a provider

```ts skip="needs a running Ollama"
import { createLLMProvider } from '@arki/ai';

const llm = createLLMProvider();
```

`createLLMProvider()` reads `LLM_PROVIDER` and `LLM_MODEL` from the environment. It never picks a paid provider on its own.

## 3. Switch to OpenAI

Set the provider and the key. Nothing else changes in your code.

```sh
LLM_PROVIDER=openai OPENAI_API_KEY=sk-... bun run dev
```

`LLM_PROVIDER` also accepts `anthropic`, `groq`, `google` and `mistral`, each with its own key variable (`ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `MISTRAL_API_KEY`).

A cloud key alone does not switch you from Ollama when Ollama is configured: set `LLM_PROVIDER` to force the cloud provider.

## 4. Embeddings

Embeddings are separate. This package no longer makes vectors: use `@arki/embeddings` (`createEmbedder`), then give `embedder.space` to `createVectorIndex`.

## Check it worked

Ask the provider whether it can be called. Run it in your app, in the folder that has `@arki/ai` installed.

```sh
bun -e "import { probeLLMProvider } from '@arki/ai'; console.log(await probeLLMProvider())"
```

Expected output with `LLM_PROVIDER` unset and Ollama running with the model pulled:

```text
{
  provider: "ollama",
  model: "qwen3.6:latest",
}
```

Otherwise it prints the `ai.provider_unavailable` failure. Its `data.problem` says what to fix:

| `problem`       | Fix                                                      |
| --------------- | -------------------------------------------------------- |
| `unreachable`   | Start Ollama (`ollama serve`), or fix `OLLAMA_BASE_URL`. |
| `model_missing` | `ollama pull` the model it names.                        |
| `missing_key`   | Set the provider's key variable (step 3).                |

With `LLM_PROVIDER=openai` and `OPENAI_API_KEY` set, it prints `provider: "openai"` and `model: "gpt-4o-mini"`. If you see a provider or model you did not expect, a `LLM_PROVIDER` or `LLM_MODEL` in your shell or `.env` is overriding the default.

In a Dot app, `llm()` from `@arki/ai/dot` runs the same check at boot, and `dot doctor` shows a failed `llm` plugin when the check fails.
