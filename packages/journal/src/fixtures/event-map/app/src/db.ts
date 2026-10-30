import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import { infra } from '@arki/dot/unit';

/** Never booted by `dot explain` or by the map tests: the factory runs only when an app boots. */
export const dbUnit = infra({ name: 'db', provides: { db: () => drizzle({ client: new PGlite() }) } });
