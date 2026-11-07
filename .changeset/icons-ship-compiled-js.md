---
"@arki/icons": patch
---

Ship compiled JavaScript. Every `exports` entry now points `import`, `browser` and `default` at `dist/src/*.js` (JSX compiled with the automatic `react/jsx-runtime`) instead of raw `src/*.ts(x)`, so Vite pre-bundles the package and Node or Vitest can load it without compiling `node_modules`. The spinner SVGs are copied next to `dist/src/spinners/index.js`, so `getSpinnerUrl()` still points at a real file. `@arki/icons/vite` is unchanged and its rewritten `@phosphor-icons/react/dist/...` paths still resolve. `./flags` imports `react-flagpack/dist/style.css`, so it still needs a bundler. Export names and the API are unchanged, so this is a patch.

no docs impact: consumers import the same subpaths; only the files they resolve to changed.
no demo impact: no demo imports a changed name.
