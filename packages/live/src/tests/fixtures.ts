/**
 * Test fixtures shared by the PGlite and Postgres suites: one app (`blog`)
 * with two tables, its trigger SQL from `liveMigration`, and the payload
 * parser of `pgSource`.
 */
import type { TableTag } from '../index.js';
import { liveChannel, liveMigration } from '../pg/index.js';
import { parseHint } from '../pg/source.js';

export const CHANNEL = liveChannel('blog');

export const POSTS: TableTag = { schema: 'public', table: 'posts' };
export const USERS: TableTag = { schema: 'public', table: 'users' };

/** `liveMigration({ app: 'blog', tables: [public.posts, public.users] }).up`. */
export const TRIGGERS_SQL = liveMigration({ app: 'blog', tables: [POSTS, USERS] }).up;

export const TABLES_SQL = `
CREATE TABLE posts (id text PRIMARY KEY, title text NOT NULL, author_id text NOT NULL);
CREATE TABLE users (id text PRIMARY KEY, name text NOT NULL);
`;

/** The tag a trigger payload carries. Throws on anything else (`pgSource` turns that into a gap). */
export function parsePayload(payload: string): TableTag {
  const hint = parseHint(payload);
  if (!hint) throw new Error(`not a live hint: ${payload}`);
  return hint.tag;
}
