/**
 * The scope declaration and its consumers on the contract side: `liveScopes`,
 * `live({ scope })`, `liveManifest(contract, { scopes })`, and the wire
 * shapes that carry scope keys.
 *
 * Why these tests exist: a scope declaration decides which client hears about
 * which write. A nullable column would hide a change from readers of every
 * key; a column of another table, or a dimension or input path that does not
 * exist, would make a query silently stale. Each is refused at boot (E001)
 * instead of serving stale pages.
 */
import { oc } from '@orpc/contract';
import { char, integer, pgTable, text, uuid, varchar } from 'drizzle-orm/pg-core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { LiveMeta, LiveScopes } from '../index.js';
import { live, liveScopes } from '../drizzle/index.js';
import { LIVE_ERROR_CODES } from '../errors.js';
import { parseLiveCursor, parseLiveEvent } from '../index.js';
import { liveManifest } from '../orpc/index.js';
import { normalizeKey } from '../scopes.js';

const posts = pgTable('posts', { id: text().primaryKey(), orgId: uuid('org_id').notNull(), title: text() });
const likes = pgTable('likes', { id: text().primaryKey(), orgId: uuid('org_id').notNull() });
const notes = pgTable('notes', { id: text().primaryKey(), orgName: varchar('org_name', { length: 40 }).notNull() });
const memberships = pgTable('memberships', { userId: integer('user_id').notNull(), orgId: uuid('org_id') });

const config = expect.objectContaining({ code: LIVE_ERROR_CODES.config });

describe('liveScopes', () => {
  it('infers the dimension names and reads each key kind from its column', () => {
    const scopes = liveScopes({
      org: [
        [posts, posts.orgId],
        [likes, likes.orgId],
      ],
      user: [[memberships, memberships.userId]],
    });
    expectTypeOf(scopes).toEqualTypeOf<LiveScopes<'org' | 'user'>>();
    expect(scopes).toEqual({
      dimensions: ['org', 'user'],
      tables: [
        { tag: { schema: 'public', table: 'posts' }, dimension: 'org', column: 'org_id', kind: 'uuid' },
        { tag: { schema: 'public', table: 'likes' }, dimension: 'org', column: 'org_id', kind: 'uuid' },
        { tag: { schema: 'public', table: 'memberships' }, dimension: 'user', column: 'user_id', kind: 'int' },
      ],
    });
    expect(liveScopes({ team: [[notes, notes.orgName]] }).tables[0]?.kind).toBe('text');
  });

  it('refuses a nullable column, a column of another table, a table in two dimensions, mixed kinds, a bad type', () => {
    // @ts-expect-error a nullable scope column would hide a change from readers granted every key
    expect(() => liveScopes({ org: [[memberships, memberships.orgId]] })).toThrow(config);
    expect(() => liveScopes({ org: [[posts, likes.orgId]] })).toThrow(config);
    expect(() => liveScopes({ org: [[posts, posts.orgId]], other: [[posts, posts.orgId]] })).toThrow(config);
    expect(() =>
      liveScopes({
        org: [
          [posts, posts.orgId],
          [notes, notes.orgName],
        ],
      }),
    ).toThrow(config);
    const odd = pgTable('odd', { code: char('code', { length: 2 }).notNull(), day: integer('day').notNull() });
    expect(() => liveScopes({ org: [[odd, odd.code]] })).toThrow(config);
    expect(() => liveScopes({ org: [] })).toThrow(config);
    expect(liveScopes({ day: [[odd, odd.day]] }).tables[0]?.kind).toBe('int');
  });
});

describe('live({ scope })', () => {
  it('turns input paths and the session into plain meta; no scope keeps the meta as it was', () => {
    expect(live({ reads: [posts] })).toEqual({ live: { version: 1, reads: [{ schema: 'public', table: 'posts' }] } });
    expect(
      live({ reads: [posts], scope: { org: 'input.filter.orgId', user: 'session', team: 'input' } }).live.scope,
    ).toEqual({
      org: { from: 'input', path: ['filter', 'orgId'] },
      user: { from: 'session' },
      team: { from: 'input', path: [] },
    });
  });

  it('refuses a bad dimension name or path', () => {
    const bad: readonly Record<string, 'session' | 'input' | `input.${string}`>[] = [
      { 'or g': 'session' },
      { org: 'input.' },
      { org: 'input..x' },
      { org: `input.${Array.from({ length: 17 }, () => 'a').join('.')}` },
    ];
    for (const scope of bad) expect(() => live({ reads: [posts], scope })).toThrow(config);
    // @ts-expect-error only 'session', 'input' and 'input.<path>' are scope sources
    expect(() => live({ reads: [posts], scope: { org: 'inputx.y' } })).toThrow(config);
  });
});

const scopes = liveScopes({ org: [[posts, posts.orgId]] });
const contract = oc.$meta<LiveMeta>({});
/** A contract of one live procedure with `scope`. */
const list = (scope: { readonly org?: 'input.orgId' | 'input.ordId'; readonly team?: 'session' }) =>
  ({ list: contract.input(z.object({ orgId: z.uuid() })).meta(live({ reads: [posts], scope })) }) as const;

describe('liveManifest(contract, { scopes })', () => {
  it('carries each scope into the manifest, an input path with its key kind', () => {
    const manifest = liveManifest(
      {
        posts: {
          list: contract
            .input(z.object({ orgId: z.uuid() }))
            .meta(live({ reads: [posts], scope: { org: 'input.orgId' } })),
          get: contract
            .input(z.object({ where: z.object({ orgId: z.uuid() }).optional() }))
            .meta(live({ reads: [posts], scope: { org: 'input.where.orgId' } })),
          mine: contract.meta(live({ reads: [posts], scope: { org: 'session' } })),
          stats: contract.meta(live({ reads: [posts] })),
        },
      },
      { scopes },
    );
    expect(manifest).toEqual([
      {
        path: ['posts', 'list'],
        reads: [{ schema: 'public', table: 'posts' }],
        scope: { org: { from: 'input', path: ['orgId'], kind: 'uuid' } },
      },
      {
        path: ['posts', 'get'],
        reads: [{ schema: 'public', table: 'posts' }],
        scope: { org: { from: 'input', path: ['where', 'orgId'], kind: 'uuid' } },
      },
      { path: ['posts', 'mine'], reads: [{ schema: 'public', table: 'posts' }], scope: { org: { from: 'session' } } },
      { path: ['posts', 'stats'], reads: [{ schema: 'public', table: 'posts' }] },
    ]);
  });

  it('refuses an unknown dimension, a missing input path, and a path on a procedure without input', () => {
    expect(() => liveManifest(list({ team: 'session' }), { scopes })).toThrow(config);
    expect(() => liveManifest(list({ org: 'input.orgId' }))).toThrow(config);
    expect(() => liveManifest(list({ org: 'input.ordId' }), { scopes })).toThrow(config);
    expect(() =>
      liveManifest({ list: contract.meta(live({ reads: [posts], scope: { org: 'input.orgId' } })) }, { scopes }),
    ).toThrow(config);
  });
});

const cursor = 'a'.repeat(75);
/** A change frame of one posts tag with `scope`. */
const changeWith = (scope: unknown) => ({
  kind: 'change',
  cursor,
  tags: [{ schema: 'public', table: 'posts', scope }],
  txids: [],
});

describe('the wire shapes with scopes', () => {
  it('a change tag may name its dimension and keys; hello may carry the stream’s own keys', () => {
    const change = {
      kind: 'change',
      cursor,
      tags: [{ schema: 'public', table: 'posts', scope: { name: 'org', keys: ['a'] } }],
      txids: [],
    };
    expect(parseLiveEvent(change)).toEqual(change);
    const hello = { kind: 'hello', v: 1, mode: 'reset', cursor, manifest: [], scopes: { org: ['a'], user: 'all' } };
    expect(parseLiveEvent(hello)).toEqual(hello);
  });

  it('refuses an empty key list, a key over 512 bytes, more than 1024 keys on a tag, a bad dimension', () => {
    expect(parseLiveEvent(changeWith({ name: 'org', keys: [] }))).toMatchObject({ code: 'schema.invalid_input' });
    expect(parseLiveEvent(changeWith({ name: 'org', keys: ['k'.repeat(513)] }))).toMatchObject({ code: 'schema.invalid_input' });
    expect(parseLiveEvent(changeWith({ name: 'org', keys: ['k'.repeat(512)] }))).not.toMatchObject({ code: 'schema.invalid_input' });
    expect(
      parseLiveEvent(changeWith({ name: 'org', keys: Array.from({ length: 1025 }, (_, index) => `${index}`) })),
    ).toMatchObject({ code: 'schema.invalid_input' });
    expect(parseLiveEvent(changeWith({ name: 'o rg', keys: ['a'] }))).toMatchObject({ code: 'schema.invalid_input' });
  });
});

describe('parseLiveCursor', () => {
  it('returns a schema.invalid_input failure for text that is not a cursor, never undefined', () => {
    expect(parseLiveCursor('nope')).toMatchObject({ code: 'schema.invalid_input' });
  });
});

describe('normalizeKey', () => {
  it('writes a key the way Postgres prints it', () => {
    expect(normalizeKey('uuid', '{0E8C3B1A-1D2E-4F3A-9B8C-7D6E5F4A3B2C}')).toBe('0e8c3b1a-1d2e-4f3a-9b8c-7d6e5f4a3b2c');
    expect(normalizeKey('uuid', '0e8c3b1a1d2e4f3a9b8c7d6e5f4a3b2c')).toBe('0e8c3b1a-1d2e-4f3a-9b8c-7d6e5f4a3b2c');
    expect(normalizeKey('uuid', 'not-a-uuid')).toBeUndefined();
    expect(normalizeKey('int', '+007')).toBe('7');
    expect(normalizeKey('int', '-0')).toBe('0');
    expect(normalizeKey('int', '18446744073709551615')).toBe('18446744073709551615');
    expect(normalizeKey('int', '1.5')).toBeUndefined();
    expect(normalizeKey('text', ' A ')).toBe(' A ');
  });
});
