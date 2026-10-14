# @arki/react-hooks

Curated React hooks for ARKI apps. Thin, typed wrappers over Mantine hooks, usehooks-ts, react-hotkeys-hook and friends, so an app imports one package and gets one consistent API.

> **Source-first package.** Ships TypeScript source as the runtime entry plus `.d.ts`. Your bundler (Vite, TanStack Start, Next.js, Bun) compiles it.

## Installation

```sh
bun add @arki/react-hooks react
```

Peer dependency: `react` 19.

## Usage

One hook per subpath:

```tsx
import { useDebounce } from '@arki/react-hooks/debounce';
import { useLocalStorage } from '@arki/react-hooks/local-storage';
import { useMediaQuery } from '@arki/react-hooks/media-query';
```

Available subpaths: `async-memo`, `copy-to-clipboard`, `debounce`, `hotkeys`, `is-client`, `local-storage`, `long-press`, `media-query`, `pagination`, `timeout`, `toggle`, `touch`, `use-swipe-gesture`, `use-touch-feedback`, `use-viewport`.

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

## License

MIT
