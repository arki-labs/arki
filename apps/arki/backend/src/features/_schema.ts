import { pgSchema } from 'drizzle-orm/pg-core';

import { APP_KEY } from '../info';

export const schema = pgSchema(APP_KEY);
