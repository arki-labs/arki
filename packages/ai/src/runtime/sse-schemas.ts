/**
 * The Zod schemas of the SSE wire. They live apart from `sse.ts` so its public `.d.ts` names no Zod type
 * (`TYPES_E001`): `sse.ts` imports them as values only, which the declaration emit drops.
 */
import { z } from 'zod';

/** JSON text, parsed. Text that is not JSON is a schema issue like any other, so `parse` returns `InvalidInput`. */
export const jsonTextSchema = z.string().transform((text, context): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    context.addIssue({ code: 'custom', message: 'Expected JSON text' });
    return z.NEVER;
  }
});

const usageSchema = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  totalTokens: z.number().optional(),
});

/** One `RuntimeWireEvent` (`sse.ts`). A two-way type test in `sse.test.ts` locks it to the type. */
export const runtimeWireEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run:start') }),
  z.object({ type: z.literal('text:delta'), delta: z.string() }),
  z.object({ type: z.literal('tool:start'), tool: z.string(), args: z.unknown() }),
  z.object({ type: z.literal('tool:result'), tool: z.string(), result: z.unknown() }),
  z.object({
    type: z.literal('tool:failure'),
    tool: z.string(),
    failure: z
      .object({ code: z.string(), message: z.string(), remediation: z.string().optional(), data: z.unknown() })
      // JSON drops an undefined remediation; a ToolFailure always has the key.
      .transform(failure => ({ ...failure, remediation: failure.remediation })),
  }),
  z.object({ type: z.literal('tool:error'), tool: z.string(), error: z.string() }),
  z.object({ type: z.literal('run:finish'), text: z.string(), usage: usageSchema.optional() }),
  z.object({ type: z.literal('run:error'), failure: z.unknown() }),
]);
