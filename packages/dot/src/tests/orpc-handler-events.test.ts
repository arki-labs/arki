/**
 * `bind(logic)` emits one handler event pair per rpc call.
 *
 * Why these tests exist: observers key on `feature` + `name` (`orders` + `orders.pay.card`, the full mounted path), so `bind` must
 * report exactly the feature's name and the procedure path; apps rely on the 4xx rule (a declared 401, a
 * step's refusal are traffic, only a 5xx or a plain throw is an incident to report); and the handler's
 * context must stay free of the kernel's `$handlers`, or procedures could reach into the runtime.
 */
import { oc } from '@orpc/contract';
import { createRouterClient, implement, ORPCError } from '@orpc/server';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineFailure, orThrow } from '@arki/failure';
import { errorMap } from '@arki/failure/orpc';

import type { DotLifecycleEvent } from '../lifecycle-observer.js';
import { defineFeature, routerFor } from '../feature.js';
import { defineApp } from '../index.js';
import { rpc, rpcFor, step } from '../orpc.js';

const NotSignedIn = defineFailure('orders.not_signed_in', { status: 401 });
const Declined = defineFailure('orders.declined', { status: 402 });

type RequestContext = {
  readonly signedIn: boolean;
  readonly services: Readonly<Record<string, unknown>>;
};
const shop = rpcFor<RequestContext>();

const contract = oc.router({
  pay: {
    card: oc.output(z.string()),
    declined: oc.output(z.string()),
    broken: oc.output(z.string()),
    serverError: oc.output(z.string()),
    guarded: oc.errors(errorMap(NotSignedIn)).output(z.string()),
  },
  contextKeys: oc.output(z.array(z.string())),
});

const ordersLogic = defineFeature('orders').usecases({});
const implementer = shop.implement(contract).with(ordersLogic);
const signedIn = (ctx: { readonly signedIn: boolean }) => (ctx.signedIn ? {} : NotSignedIn());

const orders = ordersLogic.entrypoints(
  rpc(contract, implementer, impl => ({
    pay: {
      card: impl.pay.card.handler(() => 'paid'),
      declined: impl.pay.declined.handler(() => {
        throw new ORPCError('PAYMENT_REQUIRED', { status: 402, data: Declined() });
      }),
      broken: impl.pay.broken.handler(() => {
        throw new Error('db down');
      }),
      serverError: impl.pay.serverError.handler(() => {
        throw new ORPCError('INTERNAL_SERVER_ERROR');
      }),
      guarded: impl.pay.guarded.use(step(signedIn)).handler(() => 'in'),
    },
    contextKeys: impl.contextKeys.handler(({ context }) => Object.keys(context)),
  })),
);

const boot = async () => {
  const events: DotLifecycleEvent[] = [];
  const app = orThrow(
    await defineApp('shop', { observers: [event => events.push(event)] })
      .features([orders])
      .start(),
  );
  const router = implement({ orders: orders.contract })
    .$context<RequestContext>()
    .router(routerFor({ orders: orders.contract }, [orders]));
  const client = (signedInUser = true) =>
    createRouterClient(router, { context: { signedIn: signedInUser, services: app.services } }).orders;
  const handlerEvents = () => events.filter(event => event.kind === 'handler');
  return { app, client, handlerEvents };
};

describe('bind: rpc handler events', () => {
  it('emits starting then completed with the feature name and the dotted procedure path', async () => {
    const { client, handlerEvents } = await boot();

    expect(await client().pay.card()).toBe('paid');

    expect(handlerEvents()).toMatchObject([
      { status: 'starting', transport: 'rpc', feature: 'orders', name: 'orders.pay.card', appName: 'shop' },
      { status: 'completed', outcome: 'ok', transport: 'rpc', feature: 'orders', name: 'orders.pay.card' },
    ]);
  });

  it('reads a declared 4xx as a refusal and carries the failure it was thrown with', async () => {
    const { client, handlerEvents } = await boot();

    await expect(client().pay.declined()).rejects.toMatchObject({ status: 402 });

    expect(handlerEvents().at(-1)).toMatchObject({
      status: 'completed',
      outcome: 'refused',
      name: 'orders.pay.declined',
      failure: { code: 'orders.declined' },
    });
  });

  it('reads a plain throw as failed with the error', async () => {
    const { client, handlerEvents } = await boot();

    await expect(client().pay.broken()).rejects.toBeInstanceOf(Error);

    const last = handlerEvents().at(-1);
    expect(last).toMatchObject({ status: 'failed', name: 'orders.pay.broken' });
    expect(last?.error).toBeInstanceOf(Error);
  });

  it('reads a thrown ORPCError of 500 as failed', async () => {
    const { client, handlerEvents } = await boot();

    await expect(client().pay.serverError()).rejects.toMatchObject({ status: 500 });

    expect(handlerEvents().at(-1)).toMatchObject({ status: 'failed', name: 'orders.pay.serverError' });
  });

  it("sees a step's refusal inside bind as completed/refused", async () => {
    const { client, handlerEvents } = await boot();

    await expect(client(false).pay.guarded()).rejects.toMatchObject({ status: 401 });

    expect(handlerEvents().at(-1)).toMatchObject({
      status: 'completed',
      outcome: 'refused',
      name: 'orders.pay.guarded',
      failure: { code: 'orders.not_signed_in' },
    });
  });

  it("keeps the kernel's `$handlers` out of the handler's context", async () => {
    const { client } = await boot();

    const keys = await client().contextKeys();

    expect(keys.some(key => key.startsWith('$'))).toBe(false);
    expect(keys).toContain('usecases');
  });
});
