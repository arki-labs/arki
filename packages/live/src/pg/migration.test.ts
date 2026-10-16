/**
 * `liveMigration`, `liveChannel` and the payload parser, without a database.
 *
 * Why these tests exist: the trigger SQL is pasted into reviewed migrations,
 * so its exact text is a contract (plan § 4), and a table name must never
 * escape its quotes into the statement. The payload parser decides what is a
 * hint and what is a gap.
 */
import { describe, expect, it } from 'vitest';

import { LIVE_ERROR_CODES } from '../errors.js';
import { liveChannel, liveMigration } from './migration.js';
import { parseHint } from './source.js';

const posts = { schema: 'public', table: 'posts' };
const users = { schema: 'public', table: 'users' };

/** Plan § 4 with the round-8 txid (D2) and Drizzle breakpoints, written out by hand. */
const PLAN_UP = `CREATE SCHEMA IF NOT EXISTS arki_live;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION arki_live.notify_table_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM pg_notify(TG_ARGV[0],
    json_build_object('v', 1, 'tag', json_build_object('schema', TG_ARGV[1], 'table', TG_ARGV[2]),
      'txid', pg_current_xact_id()::text)::text);
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER arki_live_blog AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "public"."posts"
  FOR EACH STATEMENT EXECUTE FUNCTION arki_live.notify_table_v1('arki_live_blog_v1', 'public', 'posts');
--> statement-breakpoint
CREATE TRIGGER arki_live_blog AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "public"."users"
  FOR EACH STATEMENT EXECUTE FUNCTION arki_live.notify_table_v1('arki_live_blog_v1', 'public', 'users');
`;

const PLAN_DOWN = `DROP TRIGGER IF EXISTS arki_live_blog ON "public"."posts";
--> statement-breakpoint
DROP TRIGGER IF EXISTS arki_live_blog ON "public"."users";
`;

describe('liveMigration', () => {
  it('generates the SQL of plan § 4, deduplicated, and names the tags it publishes', () => {
    const migration = liveMigration({ app: 'blog', tables: [posts, users, posts] });
    expect(migration.up).toBe(PLAN_UP);
    expect(migration.down).toBe(PLAN_DOWN);
    expect(migration.tables).toEqual([posts, users]);
  });

  it('a partition leaf gets its own trigger that publishes the root, with or without the root', () => {
    const leaf = { schema: 'public', table: 'events_2026' };
    const root = { schema: 'public', table: 'events' };
    const migration = liveMigration({ app: 'blog', tables: [], leaves: [{ leaf, root }] });
    expect(migration.up).toContain(
      `ON "public"."events_2026"\n  FOR EACH STATEMENT EXECUTE FUNCTION arki_live.notify_table_v1('arki_live_blog_v1', 'public', 'events');`,
    );
    expect(migration.up).not.toContain('ON "public"."events"\n');
    expect(migration.down).toBe('DROP TRIGGER IF EXISTS arki_live_blog ON "public"."events_2026";\n');
    expect(migration.tables).toEqual([root]);
  });

  it('quotes names so they cannot leave their quotes', () => {
    const hostile = { schema: 'we"ird', table: `it's"; drop table posts; --` };
    const { up, down } = liveMigration({ app: 'blog', tables: [hostile] });
    expect(up).toContain(`ON "we""ird"."it's""; drop table posts; --"`);
    expect(up).toContain(`('arki_live_blog_v1', 'we"ird', 'it''s"; drop table posts; --')`);
    expect(down).toBe(`DROP TRIGGER IF EXISTS arki_live_blog ON "we""ird"."it's""; drop table posts; --";\n`);
  });

  it('refuses a bad app, no tables, an oversized name, and a leaf that is also a table', () => {
    const config = expect.objectContaining({ code: LIVE_ERROR_CODES.config });
    expect(() => liveMigration({ app: 'Blog', tables: [posts] })).toThrow(config);
    expect(() => liveMigration({ app: 'blog', tables: [] })).toThrow(config);
    expect(() => liveMigration({ app: 'blog', tables: [{ schema: 'public', table: 'x'.repeat(64) }] })).toThrow(config);
    expect(() => liveMigration({ app: 'blog', tables: [posts], leaves: [{ leaf: posts, root: users }] })).toThrow(
      config,
    );
    expect(() => liveMigration({ app: 'blog', tables: [], leaves: [{ leaf: posts, root: posts }] })).toThrow(config);
    expect(() =>
      liveMigration({ app: 'blog', tables: [{ schema: 'public', table: 'a--> statement-breakpoint b' }] }),
    ).toThrow(config);
  });
});

describe('liveChannel', () => {
  it('is arki_live_<app>_v1 for 1-24 characters of [a-z0-9_]', () => {
    expect(liveChannel('games_platform')).toBe('arki_live_games_platform_v1');
    for (const bad of ['', 'a'.repeat(25), 'my-app', 'App', 'a"b']) {
      expect(() => liveChannel(bad)).toThrow(expect.objectContaining({ code: LIVE_ERROR_CODES.config }));
    }
  });
});

const hint = (txid: unknown) => JSON.stringify({ v: 1, tag: posts, txid });

describe('parseHint', () => {
  it('reads what the trigger publishes and nothing else', () => {
    // Postgres' json text puts spaces around the colons.
    expect(
      parseHint('{"v" : 1, "tag" : {"schema" : "public", "table" : "posts"}, "txid" : "18446744073709551615"}'),
    ).toEqual({ tag: posts, txid: '18446744073709551615' });
    expect(parseHint('{"v":2,"tag":{"schema":"public","table":"posts"},"txid":"7"}')).toBeUndefined();
    expect(parseHint('{"v":1,"tag":{"schema":"public","table":"posts"},"txid":"7","extra":1}')).toBeUndefined();
    expect(parseHint('{"v":1,"tag":{"schema":"public"},"txid":"7"}')).toBeUndefined();
    expect(parseHint('not json')).toBeUndefined();
  });

  it('refuses a txid that is missing, a number, or not a positive decimal string', () => {
    expect(parseHint(JSON.stringify({ v: 1, tag: posts }))).toBeUndefined();
    // A number would lose digits past 2^53; the trigger always sends text.
    for (const bad of [7, '', '0', '07', '-1', '1.5', 'abc', '1'.repeat(21)]) {
      expect({ bad, hint: parseHint(hint(bad)) }).toEqual({ bad, hint: undefined });
    }
    expect(parseHint(hint('7'))).toEqual({ tag: posts, txid: '7' });
  });
});
