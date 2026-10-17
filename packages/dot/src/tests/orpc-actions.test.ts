/**
 * `rpc()` puts every procedure in the manifest, so `dot explain` lists what
 * a feature answers and under which policy — without booting anything.
 *
 * Why these tests exist: before, `rpc()` emitted no actions, so the oRPC
 * surface (the biggest door into most apps) was invisible to `dot explain`.
 * Two features with a procedure of the same name must not collide, and a
 * policy declared in contract meta must show up as written.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { oc } from '@orpc/contract';
import { implement, ORPCError } from '@orpc/server';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { program } from '../cli/index.js';
import { renderExplainText } from '../cli/render-explain.js';
import { textUi } from '../cli/tests/text-ui.js';
import { defineFeature, FEATURE_ERROR_CODES } from '../feature.js';
import { defineApp } from '../index.js';
import { rpc, RPC_ACTION_META_SCHEMA } from '../orpc.js';
import { digest } from './fixtures/rpc-app/digest/feature.js';
import { billing, database } from './fixtures/rpc-app/infra.js';

/** A contract with what apps actually declare: routes, errors, tags and a policy in meta. */
const storyContract = oc.$meta<{ auth?: 'user' | 'admin' }>({}).router({
  list: oc
    .route({ method: 'GET', path: '/stories', summary: 'My stories', tags: ['stories'] })
    .output(z.array(z.string())),
  remove: oc
    .meta({ auth: 'admin' })
    .route({ method: 'DELETE', path: '/stories/{id}' })
    .errors({ NOT_FOUND: {}, FORBIDDEN: {} })
    .input(z.object({ id: z.string() })),
  drafts: { list: oc.output(z.array(z.string())) },
});

const storyOs = implement(storyContract);
const stories = defineFeature('stories').entrypoints(
  rpc(storyContract, storyOs, {
    list: o => o.list.handler(() => []),
    remove: o =>
      o.remove.handler(() => {
        throw new ORPCError('NOT_FOUND');
      }),
    drafts: { list: o => o.drafts.list.handler(() => []) },
  }),
);

/** A second feature with a `list` of its own. */
const podContract = oc.router({ list: oc.output(z.array(z.string())) });
const pods = defineFeature('pods').entrypoints(
  rpc(podContract, implement(podContract), { list: o => o.list.handler(() => []) }),
);

const manifestOf = () =>
  defineApp('rpc-actions').infra(database, billing).features([digest, stories, pods]).configure().manifest;

describe('rpc(): manifest actions', () => {
  it('one action per procedure, nested routers included, owned by the feature', () => {
    const rpcActions = manifestOf().actions.filter(action => action.binding === 'rpc');
    expect(rpcActions.map(action => [action.id, action.plugin])).toEqual([
      ['digest.preview', 'digest'],
      ['stories.list', 'stories'],
      ['stories.remove', 'stories'],
      ['stories.drafts.list', 'stories'],
      ['pods.list', 'pods'],
    ]);
  });

  it('two features may both have `list`: ids carry the feature, so the app still configures', () => {
    expect(() => manifestOf()).not.toThrow();
    const ids = manifestOf().actions.map(action => action.id);
    expect(ids).toContain('stories.list');
    expect(ids).toContain('pods.list');
  });

  it('shows the HTTP route, summary, errors and the declared policy as written', () => {
    const byId = new Map(manifestOf().actions.map(action => [action.id, action]));
    expect(byId.get('stories.list')).toMatchObject({
      direction: 'in',
      address: 'GET /stories',
      summary: 'My stories',
      metaSchema: RPC_ACTION_META_SCHEMA,
      meta: { procedure: 'list', method: 'GET', path: '/stories', tags: ['stories'] },
    });
    expect(byId.get('stories.remove')).toMatchObject({
      address: 'DELETE /stories/{id}',
      meta: { procedure: 'remove', errors: ['NOT_FOUND', 'FORBIDDEN'], meta: { auth: 'admin' } },
    });
    // No route declared: the address is the procedure path, and empty meta is left out.
    expect(byId.get('digest.preview')).toMatchObject({ address: 'preview', meta: { procedure: 'preview' } });
    expect(byId.get('digest.preview')?.meta).not.toHaveProperty('meta');
  });

  it('refuses meta that is not plain JSON, where the feature is declared', () => {
    const odd = oc.$meta<{ since?: Date }>({}).router({ ping: oc.meta({ since: new Date(0) }).output(z.string()) });
    expect(() => rpc(odd, implement(odd), { ping: o => o.ping.handler(() => 'pong') })).toThrow(
      expect.objectContaining({ code: FEATURE_ERROR_CODES.rpcMetaNotJson }),
    );
  });
});

describe('dot explain: the policy a procedure declares', () => {
  // An authorization policy is declared in contract meta (`@arki/auth`'s `can` checks the same
  // name); a reviewer reading `dot explain` must see it without booting the app or reading JSON.
  const orderContract = oc.$meta<{ policy?: string }>({}).router({
    refund: oc
      .meta({ policy: 'order.refund' })
      .route({ method: 'POST', path: '/orders/{id}/refund' })
      .input(z.object({ id: z.string() })),
  });
  const orders = defineFeature('orders').entrypoints(
    rpc(orderContract, implement(orderContract), { refund: o => o.refund.handler(() => undefined) }),
  );
  const manifest = defineApp('policy-explain').features([orders]).configure().manifest;

  it('prints `policy: order.refund` under the action in the text output', () => {
    const explained = textUi();
    renderExplainText(manifest, explained.ui);
    const text = explained.text();
    expect(text).toMatch(
      /orders\.refund\s+rpc\s+in\s+POST \/orders\/\{id\}\/refund\s+orders\n\s+↳ policy: order\.refund\n/,
    );
  });

  it('carries the policy in --json as the action meta', async () => {
    // The same app as above, as a file `dot explain` discovers; it lives under this package so
    // `@orpc/*` and `zod` resolve. Run the real program and read what it prints.
    const source = (file: string): string => JSON.stringify(fileURLToPath(new URL(`../${file}`, import.meta.url)));
    const cacheDir = fileURLToPath(new URL('../../.cache', import.meta.url));
    await mkdir(cacheDir, { recursive: true });
    const appDir = await mkdtemp(path.join(cacheDir, 'orpc-explain-'));
    const appFile = path.join(appDir, 'app.ts');
    await writeFile(
      appFile,
      `import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { oc } from '@orpc/contract';
import { implement } from '@orpc/server';
import { z } from 'zod';
import { defineFeature } from ${source('feature.ts')};
import { defineApp } from ${source('define-app.ts')};
import { rpc } from ${source('orpc.ts')};

const orderContract = oc.$meta<{ policy?: string }>({}).router({
  refund: oc
    .meta({ policy: 'order.refund' })
    .route({ method: 'POST', path: '/orders/{id}/refund' })
    .input(z.object({ id: z.string() })),
});
const orders = defineFeature('orders').entrypoints(
  rpc(orderContract, implement(orderContract), { refund: o => o.refund.handler(() => null) }),
);
export default defineApp('policy-explain').features([orders]);
`,
    );
    let stdout = '';
    try {
      const code = await program.main(['explain', '--app', appFile, '-o', 'json'], {
        stdout: text => {
          stdout += text;
        },
      });
      expect(code).toBe(0);
    } finally {
      await rm(appDir, { recursive: true, force: true });
    }
    const parsed: unknown = JSON.parse(stdout);
    expect(parsed).toMatchObject({
      data: {
        actions: [
          expect.objectContaining({
            id: 'orders.refund',
            meta: expect.objectContaining({ meta: { policy: 'order.refund' } }),
          }),
        ],
      },
    });
  });
});
