---
'@arki/icons': minor
---

`@arki/icons/vite`: `phosphorPerIcon()` rewrites every named icon import from `@arki/icons/phosphor` or `@phosphor-icons/react` to the icon's own module at build time (`@phosphor-icons/react/dist/csr/<Icon>`), and `IconContext` to its context module. The app's imports stay as they are; the server stops loading the whole Phosphor index (about 300 ms at cold start) and loads only the icons it renders. `rewriteIconImports` and `phosphorIconNames` are exported for scripts.
