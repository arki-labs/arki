import { z } from 'zod';

export const UserEmail = z.object({
  email: z.string().email(),
});
