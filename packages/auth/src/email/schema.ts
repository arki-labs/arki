import { z } from '@arki/schema';

export const UserEmail = z.object({
  email: z.email(),
});
