/// <reference types="vite/client" />

// Ambient types this package's source relies on. Without this, when another
// workspace package re-exports our `.tsx` files via the `import` condition
// pointing at source, the consumer's tsc inherits our untyped ambients and
// errors on `import.meta.env` and `*.css` side-effect imports.
//
// Including this here keeps the producer self-contained: any package that
// reaches into `@arki/tanstack-start/*` source compiles cleanly without
// having to add `vite/client` to its own tsconfig.
