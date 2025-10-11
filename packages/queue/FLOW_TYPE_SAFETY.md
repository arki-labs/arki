# Flow Type Safety Guide

This guide demonstrates different approaches to achieve type safety for the `dependsOn` field in flows.

## Approach 1: Automatic Inference (Recommended) ✨

Use `defineFlowWithInference` with `as const` to automatically infer step IDs:

```typescript
import { defineFlowWithInference, defineJob } from '@arki/queue';
import { z } from 'zod';

// Define your jobs
const validateJob = defineJob({
  name: 'orders:validate',
  schema: z.object({ orderId: z.string() }),
  handler: async (data) => {
    // Validation logic
    return { valid: true };
  },
});

const paymentJob = defineJob({
  name: 'orders:payment',
  schema: z.object({ orderId: z.string() }),
  handler: async (data) => {
    // Payment logic
    return { charged: true };
  },
});

const inventoryJob = defineJob({
  name: 'orders:inventory',
  schema: z.object({ orderId: z.string() }),
  handler: async (data) => {
    // Inventory logic
    return { reserved: true };
  },
});

const notifyJob = defineJob({
  name: 'orders:notify',
  schema: z.object({ orderId: z.string() }),
  handler: async (data) => {
    // Notification logic
    return { sent: true };
  },
});

// Define flow with automatic type inference
const orderFlow = defineFlowWithInference({
  name: 'orders:process',
  schema: z.object({ orderId: z.string() }),
  flow: (input) => [
    {
      id: 'validate',
      job: validateJob,
      data: input,
    },
    {
      id: 'payment',
      job: paymentJob,
      data: input,
      dependsOn: ['validate'], // ✅ Type-safe! Autocomplete works
    },
    {
      id: 'inventory',
      job: inventoryJob,
      data: input,
      dependsOn: ['payment'], // ✅ Only accepts: 'validate' | 'payment'
    },
    {
      id: 'notify',
      job: notifyJob,
      data: input,
      dependsOn: ['payment'], // ✅ Runs in parallel with inventory
    },
  ] as const, // ⚠️ Important: 'as const' is required for type inference
});

// Trying to use an invalid step ID will cause a TypeScript error:
// dependsOn: ['invalid-step'] // ❌ TypeScript error!
```

**Pros:**
- ✅ Automatic type inference - no need to define a separate type
- ✅ Full autocomplete support in your IDE
- ✅ TypeScript catches invalid step IDs at compile time
- ✅ Works for any number of steps

**Cons:**
- ⚠️ Requires `as const` assertion on the returned array
- ⚠️ Slightly more verbose due to the `as const` requirement

## Approach 2: Explicit Type Parameter

Define step IDs explicitly as a union type:

```typescript
import { defineFlow } from '@arki/queue';

// Define your step IDs as a union type
type OrderFlowSteps = 'validate' | 'payment' | 'inventory' | 'notify';

// Define flow with explicit type parameter
const orderFlow = defineFlow<OrderInput, OrderFlowSteps>({
  name: 'orders:process',
  schema: orderSchema,
  flow: (input) => [
    {
      id: 'validate',
      job: validateJob,
      data: input,
    },
    {
      id: 'payment',
      job: paymentJob,
      data: input,
      dependsOn: ['validate'], // ✅ Type-safe!
    },
    {
      id: 'inventory',
      job: inventoryJob,
      data: input,
      dependsOn: ['payment'], // ✅ Type-safe!
    },
    {
      id: 'notify',
      job: notifyJob,
      data: input,
      dependsOn: ['payment'],
    },
  ],
});
```

**Pros:**
- ✅ No `as const` required
- ✅ Clear documentation of all step IDs upfront
- ✅ Can be extracted to a shared type file

**Cons:**
- ⚠️ Requires manual maintenance of the step ID union type
- ⚠️ Step IDs can get out of sync with actual flow definition

## Approach 3: No Type Safety (Not Recommended)

Use `defineFlow` without type parameters:

```typescript
const orderFlow = defineFlow({
  name: 'orders:process',
  schema: orderSchema,
  flow: (input) => [
    {
      id: 'validate',
      job: validateJob,
      data: input,
    },
    {
      id: 'payment',
      job: paymentJob,
      data: input,
      dependsOn: ['validate'], // ⚠️ No type checking
    },
  ],
});
```

**Pros:**
- ✅ Simplest syntax

**Cons:**
- ❌ No type safety for `dependsOn`
- ❌ No autocomplete
- ❌ Typos won't be caught at compile time

## Comparison Table

| Feature | Approach 1 (Inference) | Approach 2 (Explicit) | Approach 3 (No Safety) |
|---------|------------------------|----------------------|------------------------|
| Type safety | ✅ Full | ✅ Full | ❌ None |
| Autocomplete | ✅ Yes | ✅ Yes | ❌ No |
| Requires `as const` | ✅ Yes | ❌ No | ❌ No |
| Manual type maintenance | ❌ No | ✅ Yes | ❌ No |
| Simplicity | ⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |

## Recommendations

1. **For most cases**: Use **Approach 1** (automatic inference) with `defineFlowWithInference` and `as const`. This provides the best balance of type safety and ergonomics.

2. **For complex flows**: Use **Approach 2** (explicit types) if you want to document step IDs upfront or share types across modules.

3. **For simple flows**: If you have a very simple flow (2-3 steps) and don't need type safety, **Approach 3** is acceptable, but not recommended.

## TypeScript Configuration

For the best experience with type inference, ensure your `tsconfig.json` has:

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true
  }
}
```

## Limitations

TypeScript's type inference has some limitations:

1. **Function return types**: TypeScript doesn't automatically preserve literal types from function return values without explicit type annotations or const assertions.

2. **Circular dependencies**: The `dependsOn` field can reference any step ID, including steps defined later in the array. TypeScript handles this correctly, but keep in mind that the runtime validation will catch circular dependencies.

3. **Dynamic step generation**: If your flow steps are generated dynamically (e.g., based on input data), type inference becomes more limited. In such cases, consider using explicit type parameters.

## Migration Guide

If you have existing flows using `defineFlow` without type parameters:

1. Replace `defineFlow` with `defineFlowWithInference`
2. Add `as const` to the end of your steps array
3. Verify type checking works with your `dependsOn` references

Example:

```typescript
// Before
const flow = defineFlow({
  name: 'my-flow',
  schema: mySchema,
  flow: (input) => [...],
});

// After
const flow = defineFlowWithInference({
  name: 'my-flow',
  schema: mySchema,
  flow: (input) => [...] as const,
});
```
