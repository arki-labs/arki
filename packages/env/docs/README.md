# @arki/env notes

## API improvement ideas

1. Provide a shared `createEnv(config)` signature where the runtime is implied by the import path (`@arki/env/server` vs `@arki/env/client`) while still returning typed helpers (e.g., `.get`, `.toJSONSafe`).
2. Offer specialized factories `defineServerEnv` and `defineClientEnv` that enforce correct runtime defaults, transformers, and redaction rules.
3. Include a `withPrefix('NEXT_PUBLIC_')` helper to apply naming conventions and map server vars to client-safe names automatically.
4. Add runtime guards like `assertEnvReady()` and helper methods like `optional('SOME_VAR')` to cut down on manual null checks and boilerplate.
5. Ship an `EnvTester` utility for tests that loads overrides from a partial object, validates, and restores originals when tests finish.

## Implementation recommendations

- Place the core factory in `packages/arki/env/src/index.ts`, letting it accept a zod schema + options and wiring each entry point to the right runtime (server import -> env-core, client import -> env-nextjs).
- Export TypeScript inference helpers (`ServerEnv`, `ClientEnv`) so consuming apps get IntelliSense without declaring types manually.
- Add shared utilities for redacting secrets when logging and for serializing the validated state into Next.js runtime config.
- Wrap @t3-oss errors in a single `EnvValidationError` that adds context about the failing variable and expected type before rethrowing.
- Document how to compose per-app overrides and how to test env definitions, ideally with examples in this docs folder.

## Import-path split

- Create `packages/arki/env/server/index.ts` to wrap @t3-oss/env-core (or env-nextjs server helpers) and export server-only utilities like `createServerEnv` / `defineServerEnv`.
- Create `packages/arki/env/client/index.ts` that re-exports client-safe helpers built on @t3-oss/env-nextjs and enforces `NEXT_PUBLIC_` (or configured) prefixes.
- Configure `package.json` exports so consumers import via `@arki/env/server` or `@arki/env/client`, each pointing to the correct build artifacts.
- Optionally add `exports["./client"].browser` to keep bundlers like Next.js from bundling server code into client builds.
- Make sure documentation clearly states that server utilities must never run in the browser bundle.
