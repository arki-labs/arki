import { z } from '@arki/contracts';

export const UserEmail = z.object({
  email: z.email(),
});
