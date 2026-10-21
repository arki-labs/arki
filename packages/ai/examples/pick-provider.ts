import { resolveEmbeddingSelection, resolveLlmModel } from '../src/index.js';

// #region pick-provider
/** What the app will call, given an environment map. Nothing is sent over the network. */
export function describeSetup(environment: Readonly<Record<string, string | undefined>>) {
  return {
    // `LLM_PROVIDER` and `LLM_MODEL` come from the process environment; ollama is the default.
    chatModel: resolveLlmModel(),
    // The embedding choice is pure: pass the map in. `null` means nothing is configured.
    embeddings: resolveEmbeddingSelection(environment),
  };
}
// #endregion pick-provider
