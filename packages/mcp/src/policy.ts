import { z } from 'zod';

import type { ToolName } from './types.js';

const TOOL_NAME_PATTERN = /^[\d_a-z][\da-z]*_\w+$/;

const toolNameSchema = z.custom<ToolName>(value => typeof value === 'string' && TOOL_NAME_PATTERN.test(value));

const textListSchema = z.array(z.string()).readonly();

const accessSchema = z.union([
  z.literal('public'),
  z.literal('user'),
  z.object({ roles: textListSchema.optional(), scopes: textListSchema.optional() }),
]);

const sharedShape = {
  description: z.string(),
  access: accessSchema,
  name: toolNameSchema.optional(),
  idempotent: z.boolean().optional(),
  openWorld: z.boolean().optional(),
  budget: z.object({ maxChars: z.number().int().positive() }).readonly().optional(),
  remediation: z.record(z.string(), z.string()).readonly().optional(),
  hidden: z.literal(true).optional(),
};

/**
 * The policy a contract procedure carries in `meta.mcp`, checked when a router is turned into
 * tools. The type test in `policy.test-d.ts` locks this schema to `McpMeta` in both directions.
 */
export const mcpPolicySchema = z.discriminatedUnion('effect', [
  z.object({ ...sharedShape, effect: z.literal('read') }).readonly(),
  z.object({ ...sharedShape, effect: z.literal('write') }).readonly(),
  z
    .object({
      ...sharedShape,
      effect: z.literal('destructive'),
      confirm: z.union([z.literal('elicit'), z.object({ none: z.string() }).readonly()]),
    })
    .readonly(),
]);
