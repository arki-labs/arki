/**
 * The fixture app's oRPC contract, shared by the browser, the server and the
 * e2e global setup (which installs the triggers for `manifest`'s tables).
 */
import { oc } from '@orpc/contract';
import { z } from 'zod';

import type { LiveMeta, TableTag } from '@arki/live';
import { live } from '@arki/live';
import { liveManifest } from '@arki/live/orpc';

/** The `app` of `liveMigration` and `pgSource`: it names the NOTIFY channel. */
export const LIVE_APP_NAME = 'live_e2e';

export const POSTS_TABLE: TableTag = { schema: 'public', table: 'posts' };

/** `created_at` orders the list, so a new post is always the last item. */
export const CREATE_POSTS_SQL = `create table posts (
  id text primary key,
  title text not null,
  created_at timestamptz not null default clock_timestamp()
)`;

const procedure = oc.$meta<LiveMeta>({});
const postSchema = z.object({ id: z.string(), title: z.string() });

export const appContract = {
  posts: {
    list: procedure.meta(live({ reads: [POSTS_TABLE] })).output(z.array(postSchema)),
    create: procedure
      .input(z.object({ title: z.string().min(1) }))
      .output(z.object({ id: z.string(), receipt: z.string() })),
  },
};

export const liveAppManifest = liveManifest(appContract);
