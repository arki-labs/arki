/**
 * Schema barrel.
 *
 * Per-collection Zod schemas live in their own files (e.g. `post.ts`,
 * `user.ts`) and re-export here. Schemas double as runtime validation
 * for incoming server data AND as the source of inferred collection types.
 *
 * Use `@arki/contracts` for the `z` import to match workspace convention:
 *
 *   import { z } from '@arki/contracts';
 *
 *   export const postSchema = z.object({
 *     id: z.string(),
 *     title: z.string(),
 *     // ...
 *   });
 *   export type Post = z.infer<typeof postSchema>;
 */

export {};
