---
'@arki/tanstack-start': minor
---

Breaking: `reactCompiler()` is removed from `@arki/tanstack-start/vite`, with its Babel dependencies (`@babel/core`, `@rolldown/plugin-babel`, `babel-plugin-react-compiler`). Use `@vitejs/plugin-react`'s own option instead: `viteReact({ compiler: true })`, which runs the Rust React Compiler (`oxc-transform-react`; add it as a dev dependency of the app). It is much cheaper at build time than the Babel plugin, and it has to live in `viteReact()` because it replaces that plugin's JSX and Fast Refresh step.
