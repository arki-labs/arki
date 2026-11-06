AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/geo

Coordinate and distance maths, geocoding with provider fallback and a cache, and React hooks and Google Maps components. When a doc and the code disagree, `src/index.ts`, `src/client.ts`, `src/geocoding/index.ts` and `src/maps/google/index.ts` win.

## Laws

1. Functions that take untrusted input return a failure. They do not throw.
2. `geocode` passes to the next provider when one finds nothing. `AddressNotFound` is returned only when every provider that answered found nothing.
3. A missing address and a failure are never cached.
4. Span attributes never carry the address, the coordinates, the cache key, provider messages or API keys.
5. `@arki/geo/geocoding` is server only. The root entry and `./react` do no I/O.
6. Apps import Google Maps components from `@arki/geo/react/google-maps` and never import `@vis.gl/react-google-maps` directly.
7. `react`, `react-dom` and `@vis.gl/react-google-maps` stay optional peers.
8. Every error code has JSDoc with a summary, `@fix` and `@verify`.
9. Types are written once and inferred everywhere.
10. A public export is never deleted because nothing uses it. This is a general-purpose library.
11. Breaking changes are a minor changeset while the version is 0.x.

## Changing this package

1. Read `docs/agent-guide.md` for your task.
2. Change `src/`. Put the test next to it.
3. Keep README blocks compiling. A block marked `skip` needs a reason.
4. Add a changeset.
5. Regenerate the import paths in `llms.txt`: `bun ../../tooling/library/src/llms.ts --write`.

## Verify

```sh
bun run build && bun run typecheck && bun run lint && bun run test
bun run test:docs
bun run test:runtimes
bun ../../tooling/library/src/llms.ts --check
```
