---
"@arki/ui": patch
---

Ship compiled JavaScript. Every `exports` entry now points `import`, `browser` and `default` at `dist/src/*.js` (JSX compiled with the automatic `react/jsx-runtime`, `'use client'` kept) instead of raw `src/*.ts(x)`, so Vite pre-bundles the package and Node or Vitest can load it without compiling `node_modules`. Together with the `@arki/icons` change, 83 of 84 entries load in plain Node; `./spinners` still needs a bundler, because `react-spinners` is CommonJS without named exports. Export names and the API are unchanged, so this is a patch.

no docs impact: consumers import the same subpaths; only the files they resolve to changed.
no demo impact: no demo imports a changed name.
