import { resolveLlmModel } from '../src/index.js';

// #region pick-provider
/** What the app will call. Nothing is sent over the network. */
export function describeSetup() {
  return {
    // `LLM_PROVIDER` and `LLM_MODEL` come from the process environment; ollama is the default.
    chatModel: resolveLlmModel(),
  };
}
// #endregion pick-provider
