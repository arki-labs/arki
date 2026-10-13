/**
 * Test helper: an in-memory PGlite with a schema pushed, the fixture every
 * journal test rebuilds by hand. `@electric-sql/pglite` and `drizzle-kit` are
 * optional peers. Import this module only from tests. This is the one file
 * that may import them.
 */
import { PGlite } from '@electric-sql/pglite';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { drizzle } from 'drizzle-orm/pglite';

/**
 * Open a fresh in-memory database with `schema` (the journal tables and the
 * app's tables) pushed. Returns the Drizzle database and the PGlite client;
 * call `client.close()` when the test file ends.
 */
export async function openJournalDb(schema: Record<string, unknown>) {
  const client = new PGlite('memory://');
  await client.waitReady;
  const db = drizzle({ client });
  const { apply } = await pushSchema(schema, db);
  await apply();
  return { db, client };
}
