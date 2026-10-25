---
'@arki/ai': patch
---

`@arki/ai/react` now exports `initialRuntimeUiState`, `runtimeEventReducer` and the types `useRuntimeStream` speaks (`RuntimeUiState`, `RuntimeToolCall`, `RuntimeUiStatus`, `RuntimeEvent`, `RuntimeUsage`, `ToolFailure`). Browser code that folds or names runtime state imports them from the react entry instead of the root, which also carries server-only providers (the Qdrant provider reads `node:crypto`) and crashed a browser bundle. A test bundles the react entry for the browser and fails if it pulls in the vector-search providers.

no docs impact: `llms.txt` import paths regenerated; the README documents entries, not their member lists.
no demo impact: no demo uses the runtime reducer.
