import { z } from 'zod/v4';

export const UserEmail = z.object({
  email: z.string().email(),
});
