# Set up embeddings

Local Ollama is the default. Set `EMBEDDING_MODEL` to choose another model. OpenAI is used only when `OPENAI_API_KEY` is set and Ollama is not configured.

## Steps

1. Install the package: `bun add @arki/embeddings @arki/failure`.
2. Pull the default model: `ollama pull qwen3-embedding:0.6b`.
3. Point the app at Ollama: `OLLAMA_BASE_URL=http://127.0.0.1:11434`. Without `OLLAMA_BASE_URL` and `EMBEDDING_MODEL`, the next provider in the order `ollama → openai → voyage → google` that has its key wins, and with none the result is `ConfigurationFailure`.
4. For OpenAI, set `OPENAI_API_KEY`, remove `OLLAMA_BASE_URL` (or set `EMBEDDING_MODEL=openai:text-embedding-3-small`), and install the peers: `bun add ai @ai-sdk/openai`.
5. Store `spaceId(batch.space)` next to every index. When you change the model, re-embed the corpus.

## Check it

This script resolves the model from a variable record without touching the network, and prints the space it will write vectors in.

```ts run expect
import { createEmbedder, resolveEmbeddingModel, spaceId } from '@arki/embeddings';
import { isFailure } from '@arki/failure';

const model = resolveEmbeddingModel(undefined, { OLLAMA_BASE_URL: 'http://127.0.0.1:11434' });
if (isFailure(model)) throw new Error(model.message);
const embedder = createEmbedder(model);
if (isFailure(embedder)) throw new Error(embedder.message);
console.log(spaceId(embedder.space));
```

```text
ollama/qwen3-embedding:0.6b/1024/l2/f32/i1
```
