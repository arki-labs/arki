/**
 * Test fixtures shared by the PGlite and Postgres suites: the trigger SQL of
 * plan § 4 for one app (`blog`) and two tables, and the payload parser a
 * Postgres source applies. `liveMigration` and `pgSource` (M1) generate and
 * parse the same shapes.
 */
import { z } from 'zod';

import type { TableTag } from '../index.js';
import { tableTagSchema } from '../index.js';

export const CHANNEL = 'arki_live_blog_v1';

/** `liveMigration({ app: 'blog', tables: [public.posts, public.users] }).up`, written out. */
export const TRIGGERS_SQL = `
CREATE SCHEMA IF NOT EXISTS arki_live;

CREATE OR REPLACE FUNCTION arki_live.notify_table_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM pg_notify(TG_ARGV[0],
    json_build_object('v', 1, 'tag', json_build_object('schema', TG_ARGV[1], 'table', TG_ARGV[2]))::text);
  RETURN NULL;
END $$;

CREATE TRIGGER arki_live_blog AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "public"."posts"
  FOR EACH STATEMENT EXECUTE FUNCTION arki_live.notify_table_v1('${CHANNEL}', 'public', 'posts');
CREATE TRIGGER arki_live_blog AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "public"."users"
  FOR EACH STATEMENT EXECUTE FUNCTION arki_live.notify_table_v1('${CHANNEL}', 'public', 'users');
`;

export const TABLES_SQL = `
CREATE TABLE posts (id text PRIMARY KEY, title text NOT NULL, author_id text NOT NULL);
CREATE TABLE users (id text PRIMARY KEY, name text NOT NULL);
`;

const payloadSchema = z.object({ v: z.literal(1), tag: tableTagSchema }).strict();

/** The tag a trigger payload carries. Throws on anything else (a real source turns that into a gap). */
export function parsePayload(payload: string): TableTag {
  return payloadSchema.parse(JSON.parse(payload)).tag;
}
