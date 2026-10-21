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

Embedding selection is separate: `EMBEDDING_PROVIDER` if set, else Ollama (when `OLLAMA_BASE_URL` or `OLLAMA_HOST` is set), else OpenAI (when `OPENAI_API_KEY` is set), else nothing. With nothing configured, the selection is `null` and your code must degrade. It never invents vectors.

## Check it worked

Print the model your app resolves. Run it in your app, in the folder that has `@arki/ai` installed.

```sh
bun -e "import { resolveLlmModel } from '@arki/ai'; console.log(resolveLlmModel())"
```

Expected output with `LLM_PROVIDER` unset:

```text
qwen3.6:latest
```

With `LLM_PROVIDER=openai` in front of the command, it prints `gpt-4o-mini`. If you see a model you did not expect, a `LLM_PROVIDER` or `LLM_MODEL` in your shell or `.env` is overriding the default.
