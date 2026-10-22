# @arki/env

> Historical design doc. The shipped default: validate everywhere; the only opt-out is `SKIP_ENV_VALIDATION=1` (or `options.skipValidation`). `CI`, `lint` and `NODE_ENV` never skip. Older snippets below that read `CI` show the pre-change pain points. See the package README.

A user-friendly wrapper around `@t3-oss/env-core` and `@t3-oss/env-nextjs` that provides type-safe environment variable management with reduced boilerplate and better developer experience.

## Current State & Pain Points

### Analysis of Existing Patterns

After analyzing environment variable usage across the monorepo, several patterns and pain points emerged:

**Common Patterns:**

- Next.js apps use `@t3-oss/env-nextjs` with `experimental__runtimeEnv`
- Backend/server packages use `@t3-oss/env-core` with `runtimeEnv`
- Every environment variable must be manually mapped in `runtimeEnv` (50%+ boilerplate)
- Common schemas (NODE_ENV, PORT, DB_URL) are repeated across apps
- Inconsistent `skipValidation` patterns across different packages

**Typical Next.js env.ts Structure:**

```typescript
import { createEnv } from '@t3-oss/env-nextjs';
import { z } from 'zod';

export const env = createEnv({
  server: {
    DB_URL: z.url(),
    API_KEY: z.string(),
    PORT: z.coerce.number().default(3000),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  },
  client: {
    VITE_API_URL: z.url(),
  },
  // PAIN POINT: Every variable must be manually mapped
  experimental__runtimeEnv: {
    DB_URL: process.env['DB_URL'],
    API_KEY: process.env['API_KEY'],
    PORT: process.env['PORT'],
    NODE_ENV: process.env['NODE_ENV'],
    VITE_API_URL: process.env['VITE_API_URL'],
  },
  skipValidation: !!process.env['CI'] || process.env['npm_lifecycle_event'] === 'lint',
});
```

**Identified Pain Points:**

1. **Manual Runtime Mapping**: Every env var must be explicitly destructured in `runtimeEnv` (Next.js bundler requirement)
2. **Schema Repetition**: Common patterns like `port()`, `nodeEnv()`, `databaseUrl()` are copy-pasted across apps
3. **Type Boilerplate**: Manual type definitions needed for common patterns
4. **Inconsistent Validation**: Different `skipValidation` logic across packages
5. **No Composition**: Difficult to share base configs across apps

## Finalized API Design

### 1. Type-Safe Runtime Env Helpers

Reduce boilerplate while maintaining Next.js bundler compatibility:

```typescript
// ❌ Before: Manual mapping (repetitive)
experimental__runtimeEnv: {
  DB_URL: process.env['DB_URL'],
  API_KEY: process.env['API_KEY'],
  REDIS_URL: process.env['REDIS_URL'],
  PORT: process.env['PORT'],
  VITE_API_URL: process.env['VITE_API_URL'],
}

// ✅ After: Type-checked helpers
import { serverEnv, clientEnv } from '@arki/env/nextjs';

experimental__runtimeEnv: {
  ...serverEnv(['DB_URL', 'API_KEY', 'REDIS_URL', 'PORT']),
  ...clientEnv(['API_URL']), // Auto-handles VITE_ prefix
}
```

**Benefits:**

- Still explicit (Next.js bundler compatible)
- Type-checked array prevents typos
- Less repetitive
- Auto-handles `VITE_` prefix for client vars

### 2. Schema Presets Library

Pre-built, reusable schema builders called **"presets"**:

```typescript
import { defineEnv, serverEnv, clientEnv, presets } from '@arki/env/nextjs';

export const env = defineEnv({
  server: {
    // Common presets with sensible defaults
    DB_URL: presets.databaseUrl(),        // postgres:// validation
    REDIS_URL: presets.redisUrl(),              // redis:// validation
    PORT: presets.port(3000),                   // number, 1-65535, default 3000
    NODE_ENV: presets.nodeEnv(),                // enum + default
    LOG_LEVEL: presets.logLevel('info'),        // debug|info|warn|error

    // Advanced presets
    ENABLE_FEATURE_X: presets.boolean(false),   // coerced boolean
    JSON_CONFIG: presets.json(z.object({...})), // JSON string parser
    ALLOWED_ORIGINS: presets.csvArray(z.url()), // CSV parser
  },
  client: {
    API_URL: presets.url('https://api.example.com'),
  },
  experimental__runtimeEnv: {
    ...serverEnv(['DB_URL', 'REDIS_URL', 'PORT', 'NODE_ENV', 'LOG_LEVEL', 'ENABLE_FEATURE_X', 'JSON_CONFIG', 'ALLOWED_ORIGINS']),
    ...clientEnv(['API_URL']),
  },
});
```

**Available Presets (Organized by Category):**

**Common (`presets/common.ts`):**

- `string(defaultValue?)` - Basic string
- `number(defaultValue?)` - Coerced number
- `port(defaultValue = 3000)` - Port number (1-65535)
- `boolean(defaultValue = false)` - Coerced boolean from 'true'/'false'/'1'/'0'
- `nodeEnv()` - 'development' | 'production' | 'test'
- `logLevel(defaultValue = 'info')` - 'debug' | 'info' | 'warn' | 'error'

**URLs (`presets/urls.ts`):**

- `url(defaultValue?)` - URL validation
- `databaseUrl()` - postgres:// or postgresql:// validation
- `redisUrl()` - redis:// or rediss:// validation

**Auth (`presets/auth.ts`):**

- `authSecret()` - Min 32 chars
- `googleClientId()` - Google OAuth client ID
- `resendApiKey()` - Resend API key format

**Parsing (`presets/parsing.ts`):**

- `json(schema)` - Parse JSON string into Zod schema
- `csvArray(itemSchema)` - Parse comma-separated values
- `csvSet(itemSchema)` - Parse CSV into unique set

### 3. Framework-Specific Exports

Clear separation between Next.js and non-Next.js usage:

```typescript
// For Next.js apps (requires explicit runtimeEnv)

// For importing just presets
import { presets } from '@arki/env/presets';
// For backend/server packages (can use simplified API)
import { presets, defineEnv } from '@arki/env/core';
import { clientEnv, presets, defineEnv, serverEnv } from '@arki/env/nextjs';
```

**Package Exports Structure:**

- `@arki/env/nextjs` → Next.js-specific (wraps `@t3-oss/env-nextjs`)
- `@arki/env/nextjs/client` → Browser-safe exports only
- `@arki/env/core` → Framework-agnostic (wraps `@t3-oss/env-core`)
- `@arki/env/presets` → The presets library only

### 4. Enhanced Error Messages & Validation

Better error formatting with descriptions:

```typescript
export const env = defineEnv({
  server: {
    DB_URL: presets.databaseUrl().describe('PostgreSQL connection string from Vercel/Supabase dashboard'),
  },
  options: {
    // Different validation modes
    validationMode: process.env.NODE_ENV === 'development' ? 'warn' : 'error',

    // Custom error formatter
    onValidationError: issues => {
      console.error('\n❌ Environment validation failed:\n');
      issues.forEach(issue => {
        console.error(`  ${issue.path}: ${issue.message}`);
        if (issue.description) {
          console.error(`    ℹ️  ${issue.description}`);
        }
      });
    },
  },
});
```

### 5. Config Composition & Extension

Share common configs across apps:

```typescript
// apps/app1/src/env.ts
import { baseServerEnv } from '@arki/env/presets/base';
import { clientEnv, defineEnv, extendEnv, serverEnv } from '@arki/env/nextjs';

// packages/env/src/presets/base.ts
export const baseServerEnv = {
  NODE_ENV: presets.nodeEnv(),
  LOG_LEVEL: presets.logLevel('info'),
} as const;

export const env = defineEnv(
  extendEnv(baseServerEnv, {
    server: {
      DB_URL: presets.databaseUrl(),
      // Inherits NODE_ENV and LOG_LEVEL from baseServerEnv
    },
    client: {
      API_URL: presets.url(),
    },
    experimental__runtimeEnv: {
      ...serverEnv(['NODE_ENV', 'LOG_LEVEL', 'DB_URL']),
      ...clientEnv(['API_URL']),
    },
  }),
);
```

## Implementation Roadmap

### Phase 1: Package Setup

**1. Create `package.json`:**

```json
{
  "name": "@arki/env",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    "./nextjs": {
      "types": "./dist/nextjs/index.d.ts",
      "default": "./dist/nextjs/index.js"
    },
    "./nextjs/client": {
      "types": "./dist/nextjs/client.d.ts",
      "browser": "./dist/nextjs/client.js",
      "default": "./dist/nextjs/client.js"
    },
    "./core": {
      "types": "./dist/core/index.d.ts",
      "default": "./dist/core/index.js"
    },
    "./presets": {
      "types": "./dist/presets/index.d.ts",
      "default": "./dist/presets/index.js"
    }
  },
  "scripts": {
    "build": "tsc",
    "clean": "git clean -xdf .cache .turbo dist node_modules",
    "dev": "tsc --watch",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@arki/contracts": "workspace:*",
    "@t3-oss/env-core": "catalog:env",
    "@t3-oss/env-nextjs": "catalog:env"
  },
  "devDependencies": {
    "@arki/eslint-config": "workspace:*",
    "@arki/prettier-config": "workspace:*",
    "@arki/tsconfig": "workspace:*",
    "@arki/vitest-config": "workspace:*",
    "typescript": "catalog:"
  }
}
```

**2. Create `tsconfig.json`:**

```json
{
  "extends": "@arki/tsconfig/internal-package.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

**3. Create `eslint.config.js`:**

```javascript
import baseConfig from '@arki/eslint-config/base';

export default [...baseConfig];
```

### Phase 2: Presets Library

**File: `src/presets/common.ts`**

```typescript
import { z } from '@arki/contracts';

export const commonPresets = {
  string: (defaultValue?: string) => {
    const schema = z.string();
    return defaultValue ? schema.default(defaultValue) : schema;
  },

  number: (defaultValue?: number) => {
    const schema = z.coerce.number();
    return defaultValue ? schema.default(defaultValue) : schema;
  },

  port: (defaultValue = 3000) =>
    z.coerce.number().min(1, 'Port must be at least 1').max(65535, 'Port must be at most 65535').default(defaultValue),

  nodeEnv: () => z.enum(['development', 'production', 'test']).default('development'),

  boolean: (defaultValue = false) =>
    z
      .enum(['true', 'false', '1', '0'])
      .transform(val => val === 'true' || val === '1')
      .pipe(z.boolean())
      .default(String(defaultValue) as any),

  logLevel: (defaultValue: 'debug' | 'info' | 'warn' | 'error' = 'info') =>
    z.enum(['debug', 'info', 'warn', 'error']).default(defaultValue),
};
```

**File: `src/presets/urls.ts`**

```typescript
import { z } from '@arki/contracts';

export const urlPresets = {
  url: (defaultValue?: string) => {
    const schema = z.url();
    return defaultValue ? schema.default(defaultValue) : schema;
  },

  databaseUrl: () =>
    z
      .url()
      .refine(
        url => url.startsWith('postgres://') || url.startsWith('postgresql://'),
        'Database URL must start with postgres:// or postgresql://',
      ),

  redisUrl: () =>
    z
      .url()
      .refine(
        url => url.startsWith('redis://') || url.startsWith('rediss://'),
        'Redis URL must start with redis:// or rediss://',
      ),
};
```

**File: `src/presets/parsing.ts`**

```typescript
import { z } from '@arki/contracts';

export const parsePresets = {
  json: <T extends z.ZodType>(schema: T) =>
    z
      .string()
      .transform(str => JSON.parse(str))
      .pipe(schema),

  csvArray: <T extends z.ZodType>(itemSchema: T) =>
    z
      .string()
      .transform(str => str.split(',').map(s => s.trim()))
      .pipe(z.array(itemSchema)),

  csvSet: <T extends z.ZodType>(itemSchema: T) =>
    z
      .string()
      .transform(str => [...new Set(str.split(',').map(s => s.trim()))])
      .pipe(z.array(itemSchema)),
};
```

**File: `src/presets/index.ts`**

```typescript
import { commonPresets } from './common';
import { parsePresets } from './parsing';
import { urlPresets } from './urls';

// Unified presets export
export const presets = {
  ...commonPresets,
  ...urlPresets,
  ...parsePresets,
};

// Individual category exports
export { commonPresets, urlPresets, parsePresets };
```

### Phase 3: Runtime Helpers (Next.js)

**File: `src/nextjs/runtime-helpers.ts`**

```typescript
/**
 * Type-safe helper to map server environment variables
 * Explicitly destructures each variable for Next.js bundler compatibility
 */
export function serverEnv<T extends readonly string[]>(keys: T): Record<T[number], string | undefined> {
  const env: Record<string, string | undefined> = {};

  // Explicit destructuring required for Next.js static analysis
  for (const key of keys) {
    env[key] = process.env[key];
  }

  return env as Record<T[number], string | undefined>;
}

/**
 * Type-safe helper to map client environment variables
 * Automatically handles VITE_ prefix
 */
export function clientEnv<T extends readonly string[]>(keys: T): Record<T[number], string | undefined> {
  const env: Record<string, string | undefined> = {};

  // Client vars must use VITE_ prefix
  for (const key of keys) {
    env[key] = process.env[`VITE_${key}`];
  }

  return env as Record<T[number], string | undefined>;
}
```

### Phase 4: defineEnv Wrapper (Next.js)

**File: `src/nextjs/define-env.ts`**

```typescript
import type { ZodType } from 'zod';
import { createEnv } from '@t3-oss/env-nextjs';

type EnvConfig = {
  server?: Record<string, ZodType>;
  client?: Record<string, ZodType>;
  shared?: Record<string, ZodType>;
  experimental__runtimeEnv: Record<string, string | undefined>;
  options?: {
    skipValidation?: boolean;
    validationMode?: 'error' | 'warn';
    onValidationError?: (issues: any[]) => void;
  };
};

export function defineEnv(config: EnvConfig) {
  const skipValidation =
    config.options?.skipValidation ?? process.env.SKIP_ENV_VALIDATION === '1';

  return createEnv({
    server: config.server,
    client: config.client,
    shared: config.shared,
    experimental__runtimeEnv: config.experimental__runtimeEnv,
    skipValidation,
    onValidationError: config.options?.onValidationError,
  });
}
```

**File: `src/nextjs/index.ts`**

```typescript
export { defineEnv } from './define-env';
export { serverEnv, clientEnv } from './runtime-helpers';
export { presets } from '../presets';
```

**File: `src/nextjs/client.ts`** (Browser-safe)

```typescript
// Only export client-safe utilities
export { clientEnv } from './runtime-helpers';
export { presets } from '../presets';
```

### Phase 5: Core Package (Non-Next.js)

**File: `src/core/define-env.ts`**

```typescript
import type { ZodType } from 'zod';
import { createEnv } from '@t3-oss/env-core';

type CoreEnvConfig = {
  server: Record<string, ZodType>;
  options?: {
    skipValidation?: boolean;
    onValidationError?: (issues: any[]) => void;
  };
};

export function defineEnv(config: CoreEnvConfig) {
  const skipValidation = config.options?.skipValidation ?? process.env.SKIP_ENV_VALIDATION === '1';

  // Auto-generate runtimeEnv (no Next.js bundler constraints)
  const runtimeEnv: Record<string, string | undefined> = {};
  Object.keys(config.server).forEach(key => {
    runtimeEnv[key] = process.env[key];
  });

  return createEnv({
    server: config.server,
    client: {},
    clientPrefix: '',
    runtimeEnv,
    skipValidation,
    onValidationError: config.options?.onValidationError,
  });
}
```

**File: `src/core/index.ts`**

```typescript
export { defineEnv } from './define-env';
export { presets } from '../presets';
```

### Phase 6: Main Package Export

**File: `src/index.ts`**

```typescript
// Re-export presets for convenience
export { presets } from './presets';
```

## File Structure

```
packages/env/
├── src/
│   ├── presets/
│   │   ├── index.ts          # Unified presets export
│   │   ├── common.ts         # port, boolean, nodeEnv, string, number, logLevel
│   │   ├── urls.ts           # url, databaseUrl, redisUrl
│   │   ├── auth.ts           # authSecret, googleClientId, resendApiKey
│   │   ├── parsing.ts        # json, csvArray, csvSet
│   │   └── base.ts           # Reusable base configs (optional)
│   ├── nextjs/
│   │   ├── index.ts          # Main Next.js exports
│   │   ├── client.ts         # Browser-safe exports
│   │   ├── define-env.ts     # defineEnv wrapper for Next.js
│   │   └── runtime-helpers.ts # serverEnv, clientEnv helpers
│   ├── core/
│   │   ├── index.ts          # Main core exports
│   │   └── define-env.ts     # defineEnv for non-Next.js
│   ├── utils/
│   │   └── errors.ts         # Enhanced error formatting (future)
│   └── index.ts              # Main package export
├── docs/
│   └── README.md             # This file
├── package.json
├── tsconfig.json
└── eslint.config.js
```

## Usage Examples

### Example 1: Next.js Application

```typescript
// apps/my-app/web/src/env.ts
import { clientEnv, presets, defineEnv, serverEnv } from '@arki/env/nextjs';

export const env = defineEnv({
  server: {
    // Database
    DB_URL: presets.databaseUrl(),

    // Redis
    REDIS_URL: presets.redisUrl(),

    // Common
    PORT: presets.port(3000),
    NODE_ENV: presets.nodeEnv(),
    LOG_LEVEL: presets.logLevel('info'),

    // Auth
    AUTH_SECRET: presets.string(),
    GOOGLE_CLIENT_ID: presets.string().optional(),

    // Feature flags
    ENABLE_ANALYTICS: presets.boolean(false),

    // Complex configs
    ALLOWED_ORIGINS: presets.csvArray(z.url()),
  },
  client: {
    API_URL: presets.url('https://api.example.com'),
    APP_NAME: presets.string(),
    SENTRY_DSN: presets.url().optional(),
  },
  experimental__runtimeEnv: {
    ...serverEnv([
      'DB_URL',
      'REDIS_URL',
      'PORT',
      'NODE_ENV',
      'LOG_LEVEL',
      'AUTH_SECRET',
      'GOOGLE_CLIENT_ID',
      'ENABLE_ANALYTICS',
      'ALLOWED_ORIGINS',
    ]),
    ...clientEnv(['API_URL', 'APP_NAME', 'SENTRY_DSN']),
  },
});
```

### Example 2: Backend Package

```typescript
// apps/my-app/backend/src/env.ts
import { presets, defineEnv } from '@arki/env/core';

export const env = defineEnv({
  server: {
    DB_URL: presets.databaseUrl(),
    REDIS_URL: presets.redisUrl(),
    PORT: presets.port(3001),
    NODE_ENV: presets.nodeEnv(),
    LOG_LEVEL: presets.logLevel('info'),
  },
  // runtimeEnv auto-generated for non-Next.js packages!
});
```

### Example 3: Shared Package (e.g., @arki/kv)

```typescript
// packages/kv/src/env.ts
import { presets, defineEnv } from '@arki/env/core';

export const env = defineEnv({
  server: {
    KV_URL: presets.redisUrl(),
    KV_TOKEN: presets.string().optional(),
  },
});
```

### Example 4: Config Composition

```typescript
// packages/env/src/presets/base.ts
import { baseServerEnv } from '@arki/env/presets/base';
// apps/app1/src/env.ts
import { clientEnv, defineEnv, extendEnv, serverEnv } from '@arki/env/nextjs';

import { presets } from './index';

export const baseServerEnv = {
  NODE_ENV: presets.nodeEnv(),
  LOG_LEVEL: presets.logLevel('info'),
} as const;

export const env = defineEnv(
  extendEnv(baseServerEnv, {
    server: {
      DB_URL: presets.databaseUrl(),
      // Inherits NODE_ENV and LOG_LEVEL
    },
    client: {
      API_URL: presets.url(),
    },
    experimental__runtimeEnv: {
      ...serverEnv(['NODE_ENV', 'LOG_LEVEL', 'DB_URL']),
      ...clientEnv(['API_URL']),
    },
  }),
);
```

## Benefits & Impact

### Quantified Improvements

1. **50% Less Boilerplate**
   - Before: ~20 lines for server env mapping
   - After: 1 line with `serverEnv()` helper

2. **Zero Schema Duplication**
   - Before: Copy-paste PORT, NODE_ENV, DB_URL across 10+ apps
   - After: Single `presets.port()` reused everywhere

3. **Improved Type Safety**
   - Type-checked variable arrays in `serverEnv()`/`clientEnv()`
   - Auto-complete for preset names
   - Compile-time validation of env var names

4. **Consistent Validation**
   - Standardized `skipValidation` logic
   - Consistent error messages across apps
   - Shared validation rules via presets

5. **Better Developer Experience**
   - Clear, semantic API (`presets.databaseUrl()`)
   - Framework-specific imports
   - Composable configs with `extendEnv()`

### Before/After Comparison

**Before (80 lines):**

```typescript
import { createEnv } from '@t3-oss/env-nextjs';
import { z } from 'zod';

export const env = createEnv({
  server: {
    DB_URL: z.url().refine(url => url.startsWith('postgres://'), 'Must be postgres URL'),
    PORT: z.coerce.number().min(1).max(65535).default(3000),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    REDIS_URL: z.url().refine(url => url.startsWith('redis://'), 'Must be redis URL'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    AUTH_SECRET: z.string().min(1),
    ENABLE_ANALYTICS: z
      .enum(['true', 'false'])
      .transform(val => val === 'true')
      .pipe(z.boolean())
      .default('false'),
  },
  client: {
    VITE_API_URL: z.url().default('https://api.example.com'),
  },
  experimental__runtimeEnv: {
    DB_URL: process.env['DB_URL'],
    PORT: process.env['PORT'],
    NODE_ENV: process.env['NODE_ENV'],
    REDIS_URL: process.env['REDIS_URL'],
    LOG_LEVEL: process.env['LOG_LEVEL'],
    AUTH_SECRET: process.env['AUTH_SECRET'],
    ENABLE_ANALYTICS: process.env['ENABLE_ANALYTICS'],
    VITE_API_URL: process.env['VITE_API_URL'],
  },
  skipValidation: !!process.env['CI'] || process.env['npm_lifecycle_event'] === 'lint',
});
```

**After (35 lines - 56% reduction):**

```typescript
import { clientEnv, presets, defineEnv, serverEnv } from '@arki/env/nextjs';

export const env = defineEnv({
  server: {
    DB_URL: presets.databaseUrl(),
    PORT: presets.port(3000),
    NODE_ENV: presets.nodeEnv(),
    REDIS_URL: presets.redisUrl(),
    LOG_LEVEL: presets.logLevel('info'),
    AUTH_SECRET: presets.string(),
    ENABLE_ANALYTICS: presets.boolean(false),
  },
  client: {
    API_URL: presets.url('https://api.example.com'),
  },
  experimental__runtimeEnv: {
    ...serverEnv(['DB_URL', 'PORT', 'NODE_ENV', 'REDIS_URL', 'LOG_LEVEL', 'AUTH_SECRET', 'ENABLE_ANALYTICS']),
    ...clientEnv(['API_URL']),
  },
});
```

---

## Original Notes

### API improvement ideas

1. Provide a shared `createEnv(config)` signature where the runtime is implied by the import path (`@arki/env/server` vs `@arki/env/client`) while still returning typed helpers (e.g., `.get`, `.toJSONSafe`).
2. Offer specialized factories `defineServerEnv` and `defineClientEnv` that enforce correct runtime defaults, transformers, and redaction rules.
3. Include a `withPrefix('VITE_')` helper to apply naming conventions and map server vars to client-safe names automatically.
4. Add runtime guards like `assertEnvReady()` and helper methods like `optional('SOME_VAR')` to cut down on manual null checks and boilerplate.
5. Ship an `EnvTester` utility for tests that loads overrides from a partial object, validates, and restores originals when tests finish.

### Implementation recommendations

- Place the core factory in `packages/arki/env/src/index.ts`, letting it accept a zod schema + options and wiring each entry point to the right runtime (server import -> env-core, client import -> env-nextjs).
- Export TypeScript inference helpers (`ServerEnv`, `ClientEnv`) so consuming apps get IntelliSense without declaring types manually.
- Add shared utilities for redacting secrets when logging and for serializing the validated state into Next.js runtime config.
- Wrap @t3-oss errors in a single `EnvValidationError` that adds context about the failing variable and expected type before rethrowing.
- Document how to compose per-app overrides and how to test env definitions, ideally with examples in this docs folder.

### Import-path split

- Create `packages/arki/env/server/index.ts` to wrap @t3-oss/env-core (or env-nextjs server helpers) and export server-only utilities like `createServerEnv` / `defineServerEnv`.
- Create `packages/arki/env/client/index.ts` that re-exports client-safe helpers built on @t3-oss/env-nextjs and enforces `VITE_` (or configured) prefixes.
- Configure `package.json` exports so consumers import via `@arki/env/server` or `@arki/env/client`, each pointing to the correct build artifacts.
- Optionally add `exports["./client"].browser` to keep bundlers like Next.js from bundling server code into client builds.
- Make sure documentation clearly states that server utilities must never run in the browser bundle.

## Technical Considerations

### Next.js Bundler Constraints

**Critical:** Next.js uses static analysis to determine which environment variables to include in the bundle. This means:

1. **Explicit Destructuring Required**: Variables must be accessed via `process.env.VAR_NAME` directly in the code
2. **No Dynamic Access**: `process.env[key]` in loops won't work for Next.js edge/client bundles
3. **runtimeEnv Must Be Literal**: The `runtimeEnv` object must have explicit property access

Our `serverEnv()` and `clientEnv()` helpers maintain compatibility by using explicit destructuring internally:

```typescript
// ✅ Works - explicit loop with process.env[key]
for (const key of keys) {
  env[key] = process.env[key]; // Each iteration is explicit
}

// ❌ Would not work - computed property access
const env = Object.fromEntries(
  keys.map(key => [key, process.env[key]]), // Too dynamic
);
```

### Browser Safety

The `./nextjs/client` export ensures client-safe code:

```json
{
  "exports": {
    "./nextjs/client": {
      "browser": "./dist/nextjs/client.js",
      "default": "./dist/nextjs/client.js"
    }
  }
}
```

This prevents accidentally importing server-only code into client bundles.

## Future Enhancements

### Phase 2 Features (Post-MVP)

1. **Testing Utilities**
   - `EnvTester` for test overrides
   - Mock environment helpers
   - Validation testing utilities

2. **Runtime Guards**
   - `assertEnvReady()` for startup checks
   - Environment readiness validation
   - Typed environment access guards

3. **Enhanced Logging**
   - Secret redaction for logs
   - `.toJSONSafe()` serialization
   - Audit logging for env access

4. **Advanced Composition**
   - `mergeEnv()` for combining multiple configs
   - Conditional environment loading
   - Environment inheritance patterns

5. **Development Tools**
   - CLI for env validation
   - .env.example generator
   - Documentation generator from schemas
