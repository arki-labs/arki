/**
 * Application contributions: `.usecases(factories, ...contributions)`.
 *
 * Why these tests exist: a contribution is application code that is not a usecase handle (the
 * journal's effects, taps and workflows). It must see exactly what a usecase sees, so an effect
 * gets the feature's private mailer, and never what only an entrypoint may see (the
 * entrypoint-only `db`). Its declarations must be readable before boot, because the journal
 * composes before the features. And it must never leak into `usecases`, or a procedure could
 * call an effect.
 */
import { describe, expect, it } from 'vitest';

import { orThrow, UnexpectedDefect } from '@arki/failure';

import type { ApplicationContribution } from '../feature.js';
import { defineApp } from '../define-app.js';
import { defineFeature, entrypointOnly, sliceOf } from '../feature.js';
import { entrypoint, infra } from '../unit-contract.js';

type Mailer = { readonly send: (to: string) => string };
type Db = { readonly url: string };

const database = infra({ name: 'db', provides: { db: (): Db => ({ url: 'pg://test' }) } });
const mailer = infra({ name: 'mailer', provides: { mailer: (): Mailer => ({ send: to => `sent:${to}` }) } });

/** A contribution in miniature: it declares a name, and binds to the deps it is handed. */
function recorder(name: string, seen: { deps?: readonly string[] }) {
  return {
    kind: 'recorder',
    key: 'recorder',
    declared: name,
    actionsOf: (feature: string) => [{ id: `${feature}.${name}`, binding: 'recorder', direction: 'in' as const }],
    bind: (deps: { readonly mailer: Mailer }) => {
      seen.deps = Object.keys(deps).sort();
      return { sent: deps.mailer.send(name) };
    },
  } satisfies ApplicationContribution<{ readonly mailer: Mailer }> & { readonly declared: string };
}

/** An app-level reader, as `journalWorker()` is: it reads each feature's bound payload from the slice record. */
const reader = entrypoint.fromFeatures({
  name: 'reader',
  provides: { payloads: ctx => ctx.$features.map(f => [f.name, sliceOf(ctx, f)['recorder']] as const) },
});

function ordersFeature(seen: { deps?: readonly string[] }) {
  const core = defineFeature('orders')
    .needs({ db: entrypointOnly(database.provides.db) })
    .infra(mailer)
    .domainServices({ pricing: () => ({ total: () => 1 }) });
  return core.usecases({ total: ({ pricing }) => () => pricing.total() }, recorder('receipt', seen)).entrypoints();
}

describe('.usecases(factories, ...contributions)', () => {
  it('binds once at boot to the usecase deps only: no entrypoint-only need, no usecases, no kernel keys', async () => {
    const seen: { deps?: readonly string[] } = {};
    const app = orThrow(
      await defineApp('contrib').infra(database).features([ordersFeature(seen)]).entrypoints(reader).boot(),
    );
    expect(seen.deps).toEqual(['mailer', 'pricing']);
    expect(app.services.payloads).toEqual([['orders', { sent: 'sent:receipt' }]]);
    orThrow(await app.dispose());
  });

  it('exposes its declarations before boot and adds its actions under the feature name', () => {
    const orders = ordersFeature({});
    expect(orders.contributions.map(c => ('declared' in c ? c.declared : undefined))).toEqual(['receipt']);
    const configured = orThrow(defineApp('contrib-manifest').infra(database).features([orders]).configure());
    expect(configured.manifest.actions).toContainEqual(
      expect.objectContaining({ id: 'orders.receipt', plugin: 'orders', binding: 'recorder' }),
    );
  });

  it('is never a usecase handle: the usecases a request sees are the factories only', async () => {
    const usecasesSeen: string[][] = [];
    const orders = defineFeature('orders')
      .infra(mailer)
      .usecases({ total: () => () => 1 }, recorder('receipt', {}))
      .provides({ probe: ({ usecases }) => (usecasesSeen.push(Object.keys(usecases)), usecases.total) })
      .entrypoints();
    const app = orThrow(await defineApp('contrib-private').features([orders]).boot());
    expect(usecasesSeen).toEqual([['total']]);
    orThrow(await app.dispose());
  });

  it('follows an instance: its actions carry the instance name and each copy binds on its own', async () => {
    const seen: { deps?: readonly string[] } = {};
    const orders = ordersFeature(seen);
    const configured = orThrow(
      defineApp('contrib-instances')
        .infra(database)
        .features([orders.instance('eu'), orders.instance('us')])
        .configure(),
    );
    const ids = configured.manifest.actions.filter(a => a.binding === 'recorder').map(a => a.id);
    expect([...ids].sort()).toEqual(['orders#eu.receipt', 'orders#us.receipt']);
    expect(orders.instance('eu').contributions).toEqual(orders.contributions);
  });

  it('refuses a contribution and an entrypoint under one slice key, so neither payload silently replaces the other', () => {
    const clash = { kind: 'clash', key: 'recorder', actions: [], resolve: () => 'entrypoint' };
    expect(() =>
      defineFeature('clashing')
        .infra(mailer)
        .usecases({}, recorder('receipt', {}))
        .entrypoints(clash),
    ).toThrow(/two "recorder" entrypoints or contributions/);
  });

  it('refuses two contributions under one key', () => {
    expect(() =>
      defineFeature('twice')
        .infra(mailer)
        .usecases({}, recorder('a', {}), recorder('b', {}))
        .entrypoints(),
    ).toThrow(/two "recorder" contributions/);
  });

  it('fails the boot when its bind throws, before any request', async () => {
    const failing = defineFeature('failing')
      .usecases(
        {},
        {
          kind: 'failing',
          key: 'failing',
          bind: () => {
            throw new Error('missing "mailer"');
          },
        },
      )
      .entrypoints();
    const failure = await defineApp('contrib-fails').features([failing]).boot();
    expect(UnexpectedDefect.is(failure)).toBe(true);
    expect(failure).toMatchObject({ cause: { message: expect.stringContaining('missing "mailer"') } });
  });
});
