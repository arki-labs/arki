import type { z } from 'zod';
import { expectTypeOf } from 'vitest';

import type { McpMeta } from './contract.js';
import type { mcpPolicySchema } from './policy.js';

// Mutual assignability: `McpMeta` stays the source and the schema cannot drift from it either way.
// (Strict identity fails only on `readonly` modifiers and the intersection shape of `McpMeta`.)
expectTypeOf<z.output<typeof mcpPolicySchema>>().toExtend<McpMeta>();
expectTypeOf<McpMeta>().toExtend<z.output<typeof mcpPolicySchema>>();
