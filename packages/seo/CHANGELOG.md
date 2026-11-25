# @arki/seo

## 0.1.2

### Patch Changes

- f367180: `generateLlmsFullTxt` reads an item's detail by own key, so an item titled `constructor` or `toString` no longer prints a function's source.
- 4f24c6d: Each package README now records what it instruments, including why these packages need no spans.
- 20e2cc4: The runtime claims are now proven per entry, and the README tables show it.

  - `@arki/geo/geocoding` runs on Node, Bun and Deno only (package.json `arki.entryRuntimes`):
    `node-geocoder` needs Node's `readline`. The rest of `@arki/geo` runs on all five engines.
  - `@arki/seo/react` and `@arki/tanstack-start/error` are bundler-only entries. They are now proven as a
    bundle on each engine they claim, which is how an app loads them.
  - `@arki/queue` now passes on Deno, run straight from `node_modules` as a Deno app does.
  - `@arki/payments-native` now passes on Hermes.

  No code in these packages changed.

  no docs impact: README runtime sections only.
  no demo impact: no behaviour change.

- 763b232: Declares the engines it supports and documents them in the README.
- 744896d: Add the README standard sections, `AGENTS.md` and an agent guide.

## 0.1.1

### Patch Changes

- f3c95a0: An Invalid Date no longer fails the whole sitemap or Article JSON-LD: the sitemap lists the URL without `<lastmod>`, and Article omits the bad date.
