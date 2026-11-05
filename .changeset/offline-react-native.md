---
"@arki/offline": minor
---

`@arki/offline` now claims Hermes (React Native) only for `./collections`. `./query`, `./mutations`, `./preset`, `./status` and `./devtools` run on Node, Bun, Deno and browsers: they need IndexedDB, browser `online`/`offline` events or the DOM, which React Native lacks. On React Native, queue writes with `@tanstack/offline-transactions/react-native` and persist queries with TanStack's AsyncStorage persister.

React Native sets `window` without browser APIs, and the package took that `window` for a browser. Now it tests for the features themselves:

- `./status` no longer throws on import, and a `navigator` without `onLine` counts as online.
- The queue no longer throws when it starts. Without IndexedDB, every enqueue returns `offline.queue_storage_unavailable`.
- `createLocalCollection` no longer listens for `storage` events on a `window` that has no events.

`./collections` on React Native needs `react-native-get-random-values`. Without a random source, TanStack DB refuses to build a collection.

Docs: README `## React Native` and `## Runtime support`.
