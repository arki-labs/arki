---
'@arki/ai': minor
---

The AI SDK gateway's errors are now mapped like any provider error: a gateway 429 is `RateLimited`, 401 and 403 are `ProviderUnauthorized`, other statuses are `ProviderFailed`. Before, a model given as a string id (served by the gateway) turned these into `UnexpectedDefect`. `@ai-sdk/gateway` is now a dependency.

`SemanticSearchService.indexDocuments` throws (`invariant`) when `batchSize` is not a positive integer. Before, `0` or a negative number made it loop forever.
