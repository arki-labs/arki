/** A server entry that constructs a schema the way an oRPC contract or a server function does. */
import { z } from 'zod';

export const itemSchema = z.object({ id: z.string(), count: z.number().int() });

export default {
  fetch: (): Response => Response.json(itemSchema.safeParse({ id: 'a', count: 1 })),
};
