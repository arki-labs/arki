# @arki/react-hooks

Curated React hooks for ARKI apps. Thin, typed wrappers over Mantine hooks, usehooks-ts, react-hotkeys-hook and @rehooks/local-storage, so an app imports one package and gets one consistent API.

## Install

```sh
bun add @arki/react-hooks react
```

`react` 19 is a peer dependency. There is no root import. Each hook has its own subpath.

## Quick start

A search box that waits for the user to stop typing, remembers the last query, and focuses on a key press.

```tsx
import { useDebouncedValue } from '@arki/react-hooks/debounce';
import { useHotkeys } from '@arki/react-hooks/hotkeys';
import { useLocalStorage } from '@arki/react-hooks/local-storage';

export function SearchBox({ onSearch }: { onSearch: (query: string) => void }) {
  const [query, setQuery] = useLocalStorage<string>('search-query', '');
  const [debounced] = useDebouncedValue(query, 300);

  useHotkeys('mod+k', () => document.getElementById('search')?.focus());

  return (
    <input
      id="search"
      value={query}
      onChange={event => setQuery(event.target.value)}
      onBlur={() => onSearch(debounced)}
    />
  );
}
```

## When not to use this

- You want one hook that is not here. Import it from `@mantine/hooks` or `usehooks-ts` directly. This package adds no logic to most of them.
- You need the hook outside React. These are React hooks and need a component or another hook to call them.
- You need server-side data fetching. Use your router's loader or a query library. `useAsyncMemo` runs in the browser after render.

## Runtime support

Source-distributed: ships TypeScript/TSX, needs a bundler (Vite with the TanStack Start stack).

## Public imports

One subpath per hook. Each file starts with a one-line summary, and `llms.txt` lists them all.

- `@arki/react-hooks/debounce`: `useDebouncedValue`, `useDebouncedCallback`, `useDebouncedState`.
- `@arki/react-hooks/local-storage`: `useLocalStorage`, `writeStorage`, `deleteFromStorage`.
- `@arki/react-hooks/media-query`: `useMediaQuery`, `useIsMobile`, `useIsTablet`, `useIsDesktop`, `useIsTabletOrDesktop`, `useIsTouchDevice`.
- `@arki/react-hooks/hotkeys`, `copy-to-clipboard`, `timeout`, `toggle`, `pagination`: one re-exported hook each.
- `@arki/react-hooks/async-memo`, `is-client`, `long-press`, `touch`, `use-viewport`, `use-swipe-gesture`, `use-touch-feedback`: hooks written in this package.

## Failure behaviour

Hooks do not throw for bad input. They return a value and you check it.

- `useAsyncMemo` returns `undefined` (or your `initial`) until the promise resolves. A rejected promise is not caught here: the value stays as it was, and the rejection reaches the console as an unhandled rejection. Catch inside the factory.
- On the server, `useMediaQuery` and the `useIs*` hooks return `false`, and `useViewport` returns a 1024 by 768 desktop. They update after the first effect on the client.
- `useLocalStorage` takes a default value and returns it until a stored value exists.

## Limits

- Server-rendered pages first render with the server values above, then change on the client. Do not branch markup on `useViewport()` without accepting one extra render.
- `useViewport` calls anything under 640px mobile and under 1024px tablet. `useIsMobile` calls anything under 768px mobile. Boundary: at 700px, `useViewport().isMobile` is `false` and `useIsMobile()` is `true`. Pick one family per component.
- `useAsyncMemo` drops a result when its dependencies change before it resolves. It does not cancel the request. Pass an `AbortSignal` yourself if you need that.
- `useLongPress` times with `setTimeout`. A press shorter than `delay` (500 ms by default) is a click, not a long press.

<!-- bench:start -->
## Benchmarks

Bundle size of the same hooks from @arki/react-hooks and from the main hook libraries: usehooks-ts, @mantine/hooks, react-use and ahooks. @arki/react-hooks re-exports hooks from @rehooks/local-storage, @mantine/hooks and usehooks-ts, so those libraries are measured directly to show the wrapper cost.

Measured on Node 22.13.1 (Darwin 27.0.0 arm64, Apple M2 Max (12 cores)) · @arki/bench 0.0.2 (mitata 1.0.34) · publish, seed 1592639052 · commit eeb0867c7e · 2026-10-13.

Versions: @arki/bench 0.0.2 · @arki/react-hooks 0.1.1 · @mantine/hooks 9.7.1 · @rehooks/local-storage 2.4.5 · ahooks 3.10.0 · mitata 1.0.34 · react-use 17.6.1 · usehooks-ts 3.1.1.

### useLocalStorage

Rows marked *different contract* do other work: they are measured and shown, never ranked.

| Library | Version | JS+CSS gzip | brotli | raw | Budget (gzip) | vs @arki/react-hooks |
| --- | --- | --: | --: | --: | --- | --- |
| **@arki/react-hooks** | 0.1.1 | 1.81 kB | 1.6 kB | 5.04 kB | 2 kB | baseline |
| @rehooks/local-storage (direct) | 2.4.5 | 1.81 kB | 1.6 kB | 5.04 kB | — | ≈ same |
| usehooks-ts | 3.1.1 | 1.92 kB | 1.72 kB | 4.32 kB | — | different contract: closest equivalent: other options, return shape or behaviour |
| @mantine/hooks | 9.7.1 | 939 B | 830 B | 2.27 kB | — | different contract: closest equivalent: other options, return shape or behaviour |
| react-use | 17.6.1 | 492 B | 438 B | 994 B | — | different contract: closest equivalent: other options, return shape or behaviour |
| ahooks (useLocalStorageState) | 3.10.0 | 1.53 kB | 1.38 kB | 3.65 kB | — | different contract: closest equivalent: other options, return shape or behaviour |

### useDebouncedValue

Rows marked *different contract* do other work: they are measured and shown, never ranked.

| Library | Version | JS+CSS gzip | brotli | raw | Budget (gzip) | vs @arki/react-hooks |
| --- | --- | --: | --: | --: | --- | --- |
| **@arki/react-hooks** | 0.1.1 | 331 B | 281 B | 605 B | 500 B | baseline |
| @mantine/hooks (direct) | 9.7.1 | 331 B | 283 B | 605 B | — | ≈ same |
| usehooks-ts (useDebounceValue) | 3.1.1 | 1.47 kB | 1.34 kB | 3.02 kB | — | different contract: closest equivalent: other options, return shape or behaviour |
| react-use (useDebounce) | 17.6.1 | 306 B | 267 B | 606 B | — | different contract: debounces a callback in an effect, not a value |
| ahooks (useDebounce) | 3.10.0 | 2.05 kB | 1.86 kB | 4.68 kB | — | different contract: closest equivalent: other options, return shape or behaviour |

### useMediaQuery

Rows marked *different contract* do other work: they are measured and shown, never ranked.

| Library | Version | JS+CSS gzip | brotli | raw | Budget (gzip) | vs @arki/react-hooks |
| --- | --- | --: | --: | --: | --- | --- |
| **@arki/react-hooks** | 0.1.1 | 316 B | 264 B | 543 B | 500 B | baseline |
| @mantine/hooks (direct) | 9.7.1 | 316 B | 264 B | 543 B | — | ≈ same |
| usehooks-ts | 3.1.1 | 1.43 kB | 1.28 kB | 2.95 kB | — | different contract: closest equivalent: other options, return shape or behaviour |
| react-use (useMedia) | 17.6.1 | 269 B | 219 B | 444 B | — | different contract: closest equivalent: other options, return shape or behaviour |
| ahooks (useResponsive) | 3.10.0 | 416 B | 359 B | 675 B | — | different contract: breakpoint object, not an arbitrary media query |

### Five common hooks

Rows marked *different contract* do other work: they are measured and shown, never ranked.

| Library | Version | JS+CSS gzip | brotli | raw | Budget (gzip) | vs @arki/react-hooks |
| --- | --- | --: | --: | --: | --- | --- |
| **@arki/react-hooks** | 0.1.1 | 3.2 kB | 2.88 kB | 8.52 kB | 4 kB | baseline |
| wrapped libraries (direct) | 9.7.1 | 3.19 kB | 2.87 kB | 8.53 kB | — | ≈ same |
| usehooks-ts | 3.1.1 | 2.35 kB | 2.14 kB | 5.57 kB | — | different contract: closest equivalent: other options, return shape or behaviour |
| @mantine/hooks | 9.7.1 | 1.6 kB | 1.44 kB | 4.13 kB | — | different contract: closest equivalent: other options, return shape or behaviour |
| react-use | 17.6.1 | 959 B | 866 B | 2.32 kB | — | different contract: closest equivalent: other options, return shape or behaviour |
| ahooks | 3.10.0 | 3.75 kB | 3.41 kB | 9.21 kB | — | different contract: closest equivalent: other options, return shape or behaviour |

Debounced value, media query, local storage, toggle, timeout.

**Notes**

- Only the wrapped library is the same feature as the @arki hook. Every other library offers the closest equivalent with other options, return values or behaviour, so it is measured but never ranked (`differs`).
- react-use `useDebounce` debounces a callback inside an effect, not a value. ahooks has `useDebounce` for values but no `useMediaQuery`; `useResponsive` is the nearest.
- @arki/react-hooks `useLocalStorage` is @rehooks/local-storage (synchronised across tabs and components); `useDebouncedValue`, `useMediaQuery` and `useToggle` are @mantine/hooks; `useTimeout` is usehooks-ts.
- Sizes are minified, tree-shaken, with react left out, for the browser.

Reproduce: `bunx arki-bench run --profile publish` in the package directory.

<!-- bench:meta {"schema":1,"suite":"@arki/react-hooks","specHash":"f9a0fce18134febd","profile":"publish","date":"2026-10-13T11:41:15.770Z","harness":"0.0.2"} -->
<!-- bench:end -->

## Documentation

- [docs/agent-guide.md](./docs/agent-guide.md): the model, a task map, the rules that bite, and how to verify.
- [llms.txt](./llms.txt): the short form for agents.

## Support

Report bugs and questions at <https://github.com/arki-labs/arki/issues>.

## License

MIT. See [LICENSE](./LICENSE).
