# @arki/content-build

## 0.2.0

### Minor Changes

- c6b4949: The jobs packages return failures and stop failing silently. Breaking in 0.x.

  - **`@arki/queue`.** A queue worker that fails to start in the background is logged at error level, and `stop()` and `app.dispose()` return the new `QueueWorkerStartFailed` failure (`queue.worker_start_failed`). Before, it was logged at debug level only. `outbox.schedule` returns `InvalidInput` for args that are not plain JSON or are over `maxArgsBytes`; before, it threw `OUTBOX_E003`, which is removed from `OUTBOX_ERROR_CODES`. `CronPatterns.everySeconds`, `everyMinutes`, `everyHours`, `everyDays` and `monthly` refuse `NaN` and fractions. The internal shape checks use `@arki/schema`.
  - **`@arki/offline`.** `createOfflineMutationQueue` takes `retry` (an `@arki/resilience` `Backoff`, default exponential from 1 s to 30 s, at most 5 retries) in place of `maxRetries` and `backoff`. `stop()` now cancels the wait of a running drain. `offline.dispose()` is new and removes the queue's window listeners. `persistNow()` resolves the new `QueryCachePersistFailed` failure (`offline.query_cache_persist_failed`) when IndexedDB refuses the write; before, it rejected with the raw browser error. A stored query cache that does not match its shape is dropped and refetched, not restored. New dependency: `@arki/resilience`.
  - **`@arki/content-build`.** `compileMarkdown` sanitizes raw HTML by default (GitHub rules: no `<script>`, no event handlers, no `javascript:` links). Pass `trustedHtml: true` to keep it as written. Remote cover images time out after 15 s and stop at 20 MiB (`timeoutMs`, `maxBytes`). New dependency: `rehype-sanitize`.

- b861716: Add `compileMarkdown` to `@arki/content-build/config`: compiles plain GitHub markdown (not MDX) to HTML with GFM, GitHub heading ids, autolinked headings and highlighted code, and returns the headings for a table of contents. A `rewriteLink` option rewrites, drops or keeps each link.

### Patch Changes

- e132ad3: Object checks on unknown values now use `is(value, recordSchema)` from `@arki/schema` instead of hand-written `typeof value === 'object'` guards. Behaviour is unchanged.
