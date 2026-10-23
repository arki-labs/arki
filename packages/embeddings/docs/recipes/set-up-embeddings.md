# Set up embeddings

Local Ollama is the default model of the fleet. The package reads no environment variables: your app reads its own settings and passes them to the provider's `createXModel`, so which provider runs is a line of your code.

## Steps

1. Install the package: `bun add @arki/embeddings @arki/failure`.
2. Pull the default model: `ollama pull qwen3-embedding:0.6b`.
3. Read the Ollama URL from your app's env schema (for example `OLLAMA_BASE_URL=http://127.0.0.1:11434`) and pass it as `baseURL` to `createOllamaModel`.
4. For OpenAI, install the peers (`bun add ai @ai-sdk/openai`) and call `createOpenAIModel({ apiKey })` from `@arki/embeddings/openai` with your app's key. Every other provider works the same way from its own entry.
5. Store `spaceId(batch.space)` next to every index. When you change the model, re-embed the corpus.

## Check it

This script builds the model without touching the network, and prints the space it will write vectors in.

```ts run expect
import { createEmbedder, spaceId } from '@arki/embeddings';
import { createOllamaModel } from '@arki/embeddings/ollama';
import { isFailure } from '@arki/failure';

const model = createOllamaModel({ id: 'qwen3-embedding:0.6b', baseURL: 'http://127.0.0.1:11434' });
if (isFailure(model)) throw new Error(model.message);
const embedder = createEmbedder(model);
if (isFailure(embedder)) throw new Error(embedder.message);
console.log(spaceId(embedder.space));
```

```text
ollama/qwen3-embedding:0.6b/1024/l2/f32/i1
```
