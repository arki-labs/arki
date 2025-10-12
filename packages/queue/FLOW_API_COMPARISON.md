# Flow API Comparison

This document compares the two APIs for defining flows in `@arki/queue`.

## Summary

| Feature | `defineFlow` (Array API) | `buildFlow` (Builder API) |
|---------|-------------------------|---------------------------|
| **Requires `as const`** | ✅ Yes (for type safety) | ❌ No |
| **Type-safe dependencies** | ✅ Yes | ✅ Yes |
| **Autocomplete for step IDs** | ✅ Yes | ✅ Yes |
| **Catches invalid dependencies** | ✅ At compile time | ✅ At compile time |
| **API Style** | Declarative array | Fluent/builder pattern |
| **Readability** | Good | Excellent |
| **Verbosity** | Low | Slightly higher |

## API 1: `defineFlow` (Array API with `as const`)

### Overview
The original API that requires `as const` annotation on the steps array to enable type-safe dependency validation.

### Example
```typescript
import { defineFlow, defineJob } from '@arki/queue';
import { z } from 'zod';

const validateJob = defineJob({
  name: 'order:validate',
  inputSchema: z.object({ orderId: z.string() }),
  handler: async (data) => ({ valid: true }),
});

const processJob = defineJob({
  name: 'order:process',
  inputSchema: z.object({ orderId: z.string() }),
  handler: async (data) => ({ processed: true }),
});

// ⚠️ MUST use `as const` for type safety
const orderFlow = defineFlow({
  name: 'order:process-flow',
  inputSchema: z.object({ orderId: z.string() }),
  flow: (input) => [
    {
      id: 'validate',
      job: validateJob,
      data: input,
    },
    {
      id: 'process',
      job: processJob,
      data: input,
      dependsOn: ['validate'], // ✅ Type-safe with `as const`
    },
  ] as const, // ⚠️ REQUIRED for type safety
});
```

### Pros
- Declarative and concise
- All steps defined in one array
- Familiar array syntax

### Cons
- **Easy to forget `as const`** - Without it, invalid dependencies won't be caught
- Less discoverable - developers might not know they need `as const`
- Slightly less readable for complex flows with many steps

## API 2: `buildFlow` (Builder Pattern) ⭐ **RECOMMENDED**

### Overview
A builder pattern API that provides type-safe dependency validation WITHOUT requiring `as const`.

### Example
```typescript
import { buildFlow, defineJob } from '@arki/queue';
import { z } from 'zod';

const validateJob = defineJob({
  name: 'order:validate',
  inputSchema: z.object({ orderId: z.string() }),
  handler: async (data) => ({ valid: true }),
});

const processJob = defineJob({
  name: 'order:process',
  inputSchema: z.object({ orderId: z.string() }),
  handler: async (data) => ({ processed: true }),
});

// ✅ No `as const` needed!
const orderFlow = buildFlow(
  'order:process-flow',
  z.object({ orderId: z.string() })
)
  .step('validate', {
    job: validateJob,
    data: (input) => input,
  })
  .step('process', {
    job: processJob,
    data: (input) => input,
    dependsOn: ['validate'], // ✅ Type-safe! Autocomplete works
  })
  .build();
```

### Pros
- **No `as const` required** - Type safety works automatically
- Excellent IDE autocomplete and discoverability
- Chain-able, fluent API
- Very readable, especially for complex flows
- Prevents duplicate step IDs at compile time
- Clear separation of concerns (data is a function of input)

### Cons
- Slightly more verbose
- Different paradigm (builder pattern vs declarative)
- Requires `.build()` call at the end

## Type Safety Demonstration

### With `defineFlow` (requires `as const`)

```typescript
// ❌ WITHOUT as const - No type error (BAD!)
const unsafeFlow = defineFlow({
  name: 'unsafe-flow',
  inputSchema: z.object({ id: z.string() }),
  flow: (input) => [
    { id: 'step1', job: job1, data: input },
    {
      id: 'step2',
      job: job2,
      data: input,
      dependsOn: ['step1-typo'], // ❌ No error! Will fail at runtime
    },
  ], // Missing 'as const'
});

// ✅ WITH as const - Type error (GOOD!)
const safeFlow = defineFlow({
  name: 'safe-flow',
  inputSchema: z.object({ id: z.string() }),
  flow: (input) => [
    { id: 'step1', job: job1, data: input },
    {
      id: 'step2',
      job: job2,
      data: input,
      dependsOn: ['step1-typo'], // ✅ Type error!
      //          ^^^^^^^^^^^^^ Type '"step1-typo"' is not assignable to type '"step1"'
    },
  ] as const,
});
```

### With `buildFlow` (always type-safe)

```typescript
// ✅ Always type-safe - No as const needed!
const flow = buildFlow('my-flow', z.object({ id: z.string() }))
  .step('step1', {
    job: job1,
    data: (input) => input,
  })
  .step('step2', {
    job: job2,
    data: (input) => input,
    dependsOn: ['step1-typo'], // ✅ Type error!
    //          ^^^^^^^^^^^^^ Type '"step1-typo"' is not assignable to type '"step1"'
  })
  .build();
```

## Complex Flow Example

### ETL Pipeline with `buildFlow`

```typescript
const etlFlow = buildFlow(
  'data:etl-pipeline',
  z.object({ sourceId: z.string() })
)
  .step('extract', {
    job: extractJob,
    data: (input) => ({ sourceId: input.sourceId }),
  })
  // Parallel transformations
  .step('transform-a', {
    job: transformAJob,
    data: () => ({ type: 'A' }),
    dependsOn: ['extract'],
  })
  .step('transform-b', {
    job: transformBJob,
    data: () => ({ type: 'B' }),
    dependsOn: ['extract'],
  })
  .step('transform-c', {
    job: transformCJob,
    data: () => ({ type: 'C' }),
    dependsOn: ['extract'],
  })
  // Fan-in: wait for all transforms
  .step('load', {
    job: loadJob,
    data: () => ({}),
    dependsOn: ['transform-a', 'transform-b', 'transform-c'],
  })
  // Final validation
  .step('validate-results', {
    job: validateJob,
    data: () => ({}),
    dependsOn: ['load'],
  })
  .build();
```

## Migration Guide

If you have existing flows using `defineFlow`, you can easily migrate to `buildFlow`:

### Before (defineFlow)
```typescript
const flow = defineFlow({
  name: 'my-flow',
  inputSchema: mySchema,
  flow: (input) => [
    { id: 'step1', job: job1, data: input },
    { id: 'step2', job: job2, data: input, dependsOn: ['step1'] },
  ] as const,
  options: { /* ... */ },
});
```

### After (buildFlow)
```typescript
const flow = buildFlow('my-flow', mySchema, { /* options */ })
  .step('step1', {
    job: job1,
    data: (input) => input,
  })
  .step('step2', {
    job: job2,
    data: (input) => input,
    dependsOn: ['step1'],
  })
  .build();
```

## Recommendation

**We recommend using `buildFlow` for new code** because:

1. **No `as const` required** - One less thing to remember
2. **Better IDE experience** - Autocomplete guides you through the API
3. **Self-documenting** - Method chaining makes the flow structure clear
4. **Safer by default** - Can't forget type safety annotations

The `defineFlow` API remains available for backwards compatibility and for developers who prefer the declarative array style.
