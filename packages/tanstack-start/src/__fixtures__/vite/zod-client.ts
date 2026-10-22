/** A client entry that constructs a schema: the browser bundle must stay on the plain parser. */
import { z } from 'zod';

export const formSchema = z.object({ email: z.email() });
