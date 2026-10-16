/**
 * `liveManifest`, `liveTables` and `affectedPaths` on a real oRPC contract.
 *
 * Why these tests exist: the manifest is what a client invalidates by, and
 * what the boot check and the migration cover. A nested procedure missing
 * from it never refreshes; a write procedure in it would be refetched for
 * nothing; meta that does not parse must stop the app at boot, not leave a
 * procedure silently not live.
 */
import { oc } from '@orpc/contract';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { LiveMeta, TableTag } from '../index.js';
import { affectedPaths, live, LIVE_ERROR_CODES, liveTables } from '../index.js';
import { liveManifest } from './index.js';

const tag = (table: string, schema = 'public'): TableTag => ({ schema, table });
const contract = oc.$meta<LiveMeta & { auth?: 'user' }>({});

const appContract = {
  posts: contract.router({
    list: contract.meta({ auth: 'user', ...live({ reads: [tag('posts'), tag('users')] }) }).output(z.array(z.string())),
    create: contract.input(z.object({ title: z.string() })),
    drafts: { mine: contract.meta(live({ reads: [tag('drafts', 'editor')] })).output(z.array(z.string())) },
  }),
  stats: contract.meta(live({ reads: [tag('posts')] })).output(z.int()),
  health: contract.output(z.literal('ok')),
};

describe('liveManifest', () => {
  it('lists every live procedure of nested routers by path, and skips procedures without live meta', () => {
    expect(liveManifest(appContract)).toEqual([
      { path: ['posts', 'list'], reads: [tag('posts'), tag('users')] },
      { path: ['posts', 'drafts', 'mine'], reads: [tag('drafts', 'editor')] },
      { path: ['stats'], reads: [tag('posts')] },
    ]);
  });

  it('refuses live meta that does not parse with E001, naming the procedure', () => {
    const wrongVersion = {
      broken: oc.$meta<Record<string, unknown>>({}).meta({ live: { version: 2, reads: [tag('posts')] } }),
    };
    expect(() => liveManifest(wrongVersion)).toThrow(
      expect.objectContaining({ code: LIVE_ERROR_CODES.config, message: expect.stringContaining('broken') }),
    );
    const noTables = { empty: oc.$meta<Record<string, unknown>>({}).meta({ live: { version: 1, reads: [] } }) };
    expect(() => liveManifest(noTables)).toThrow(expect.objectContaining({ code: LIVE_ERROR_CODES.config }));
  });
});

describe('liveTables and affectedPaths', () => {
  const manifest = liveManifest(appContract);

  it('liveTables names each table once, across procedures and schemas', () => {
    expect(liveTables(manifest)).toEqual([tag('posts'), tag('users'), tag('drafts', 'editor')]);
  });

  it('affectedPaths returns the procedures reading any changed table, matching schema and name', () => {
    expect(affectedPaths(manifest, [tag('posts')])).toEqual([['posts', 'list'], ['stats']]);
    expect(affectedPaths(manifest, [tag('users'), tag('drafts', 'editor')])).toEqual([
      ['posts', 'list'],
      ['posts', 'drafts', 'mine'],
    ]);
    // Same name, other schema: a different table.
    expect(affectedPaths(manifest, [tag('drafts')])).toEqual([]);
  });
});
