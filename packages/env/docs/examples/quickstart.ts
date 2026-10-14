/**
 * Worked example from `packages/dot/docs/quickstart.md`. It lives in `@arki/env` because it
 * imports `@arki/env/dot`, and `@arki/dot` must not depend on `@arki/env`.
 *
 * This file is intentionally minimal and dependency-light:
 *
 *   - `@arki/dot`   — the kernel
 *   - `@arki/env`   — env validation adapter
 *   - `zod`         — schema runtime
 *
 * Drivers are chosen so the example boots on any laptop with no external
 * services. `env` skips validation so the example never depends on a host
 * env var; the schema's defaults are exercised instead.
 *
 * Used by:
 *
 *   - The quickstart tutorial, as the canonical 5-minute boot path.
 *   - The release-tooling fixture matrix (Task 11 + future expansions),
 *     which packs `@arki/dot` and `@arki/env` and runs this file to assert
 *     it boots end-to-end on npm/pnpm/bun.
 */

import { defineApp } from '@arki/dot';
import { env } from '@arki/env/dot';
import { z } from 'zod';

export const app = await defineApp('my-app')
  .use(
    env({
      schema: {
        PORT: z.coerce.number().default(3000),
        NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
      },
      skipValidation: true,
    }),
  )
  .boot();

// Static graph — what the app *is*.
console.log('manifest:', JSON.stringify(app.manifest, null, 2));

// Runtime snapshot — how the app *is doing*.
console.log('diagnostics:', JSON.stringify(app.diagnostics, null, 2));

// Typed services — `PORT` is `number`, not `string`.
console.log(`booted ${app.name} on port ${String(app.services.env.PORT)}`);

// Clean shutdown. Both calls are idempotent.
await app.stop();
await app.dispose();
