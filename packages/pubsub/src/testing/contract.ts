/**
 * The conformance suite every backend runs. It proves the contract's
 * semantics: delivery after `subscribe`, no replay, per-channel order, the
 * limits, and, for a transactional backend, commit-time delivery.
 */
import { describe, expect, it } from 'vitest';

import type { OnMessage, PubSub, TransactionalPubSub, Unsubscribe } from '../types.js';
import { PubSubError } from '../errors.js';
import { MAX_PAYLOAD_BYTES } from '../limits.js';

/** A fresh pubsub for one case. The suite closes it. */
export type PubSubSubject = { readonly pubsub: PubSub };

/** A fresh transactional pubsub for one case, with a way to open a transaction it can publish in. */
export type TransactionalPubSubSubject<Tx> = {
  readonly pubsub: TransactionalPubSub<Tx>;
  /** Runs `fn` in one transaction: commits when it resolves, rolls back when it throws. Usually `fn => db.transaction(fn)`. */
  readonly transaction: (fn: (tx: Tx) => Promise<void>) => Promise<void>;
};

export type PubSubContractOptions = {
  /** How long to wait before saying nothing arrived. Default 150 ms; a polling backend needs a few intervals. */
  readonly settleMs?: number;
  /** How long to wait for a message that must arrive. Default 5000 ms. */
  readonly timeoutMs?: number;
  /** True when two `make()` results share one transport (a database or a server), so one hears the other. Default true. */
  readonly shared?: boolean;
};

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

let channelCount = 0;
const run = Math.random().toString(36).slice(2, 8);

/** A channel no other case uses, so cases on a shared database or server never hear each other. */
function freshChannel(): string {
  channelCount += 1;
  return `contract_${run}_${channelCount}`;
}

class Rollback extends Error {}

function ignore(): void {
  // A subscriber that is never meant to be called.
}

/** Subscribes and collects what arrives. */
async function listen(
  pubsub: PubSub,
  channel: string,
): Promise<{ readonly messages: string[]; readonly unsubscribe: Unsubscribe }> {
  const messages: string[] = [];
  const onMessage: OnMessage = payload => {
    messages.push(payload);
  };
  const unsubscribe = await pubsub.subscribe(channel, onMessage);
  return { messages, unsubscribe };
}

/**
 * Register the conformance cases with vitest. `make` returns a fresh pubsub per case; return
 * `{ pubsub, transaction }` for a backend with `publishIn` to run the transaction cases too.
 */
export function describePubSubContract<Tx>(
  name: string,
  make: () => Promise<PubSubSubject | TransactionalPubSubSubject<Tx>>,
  options: PubSubContractOptions = {},
): void {
  const settleMs = options.settleMs ?? 150;
  const timeoutMs = options.timeoutMs ?? 5000;
  const shared = options.shared ?? true;

  async function until(check: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await sleep(5);
    }
  }

  /** Runs `body` with a fresh subject and always closes it. */
  async function withSubject(
    body: (subject: PubSubSubject | TransactionalPubSubSubject<Tx>) => Promise<void>,
  ): Promise<void> {
    const subject = await make();
    try {
      await body(subject);
    } finally {
      await subject.pubsub.close();
    }
  }

  describe(`${name} (pubsub contract)`, () => {
    it('delivers a message to a subscriber', () =>
      withSubject(async ({ pubsub }) => {
        const channel = freshChannel();
        const { messages } = await listen(pubsub, channel);
        await pubsub.publish(channel, 'hello');
        await until(() => messages.length === 1, 'the message');
        expect(messages).toEqual(['hello']);
      }));

    it('does not deliver messages of other channels', () =>
      withSubject(async ({ pubsub }) => {
        const mine = freshChannel();
        const other = freshChannel();
        const { messages } = await listen(pubsub, mine);
        await pubsub.publish(other, 'not yours');
        await pubsub.publish(mine, 'yours');
        await until(() => messages.includes('yours'), 'the message on my channel');
        await sleep(settleMs);
        expect(messages).toEqual(['yours']);
      }));

    it('does not replay messages published before subscribe', () =>
      withSubject(async ({ pubsub }) => {
        const channel = freshChannel();
        await pubsub.publish(channel, 'early');
        const { messages } = await listen(pubsub, channel);
        await pubsub.publish(channel, 'late');
        await until(() => messages.includes('late'), 'the late message');
        await sleep(settleMs);
        expect(messages).toEqual(['late']);
      }));

    it('keeps the order of one publisher on one channel', () =>
      withSubject(async ({ pubsub }) => {
        const channel = freshChannel();
        const { messages } = await listen(pubsub, channel);
        const sent = Array.from({ length: 20 }, (_, index) => `m${index}`);
        for (const payload of sent) await pubsub.publish(channel, payload);
        await until(() => messages.length === sent.length, 'all 20 messages');
        expect(messages).toEqual(sent);
      }));

    it('delivers to every subscriber of the channel', () =>
      withSubject(async ({ pubsub }) => {
        const channel = freshChannel();
        const first = await listen(pubsub, channel);
        const second = await listen(pubsub, channel);
        await pubsub.publish(channel, 'both');
        await until(() => first.messages.length === 1 && second.messages.length === 1, 'both subscribers');
        expect([first.messages, second.messages]).toEqual([['both'], ['both']]);
      }));

    it('survives a subscriber that throws or rejects: the others still hear, nothing is left unhandled', () =>
      withSubject(async ({ pubsub }) => {
        // Why: an `async` callback is accepted where OnMessage returns void; its rejection must be logged, not crash the process.
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
        process.on('unhandledRejection', onUnhandled);
        try {
          const channel = freshChannel();
          await pubsub.subscribe(channel, () => {
            throw new Error('sync subscriber bug');
          });
          // eslint-disable-next-line @typescript-eslint/no-misused-promises -- the case under test: an async callback where OnMessage returns void
          await pubsub.subscribe(channel, async () => {
            await Promise.resolve();
            throw new Error('async subscriber bug');
          });
          const good = await listen(pubsub, channel);
          await pubsub.publish(channel, 'still delivered');
          await until(() => good.messages.length === 1, 'the healthy subscriber');
          await sleep(settleMs);
          expect(unhandled).toEqual([]);
        } finally {
          process.off('unhandledRejection', onUnhandled);
        }
      }));

    it('stops delivery to a subscription after unsubscribe', () =>
      withSubject(async ({ pubsub }) => {
        const channel = freshChannel();
        const gone = await listen(pubsub, channel);
        const kept = await listen(pubsub, channel);
        await gone.unsubscribe();
        await gone.unsubscribe();
        await pubsub.publish(channel, 'after');
        await until(() => kept.messages.length === 1, 'the kept subscriber');
        await sleep(settleMs);
        expect(gone.messages).toEqual([]);
        // The channel is heard again by a new subscription after its last one left.
        await kept.unsubscribe();
        const again = await listen(pubsub, channel);
        await pubsub.publish(channel, 'again');
        await until(() => again.messages.length === 1, 'the new subscriber');
        expect(again.messages).toEqual(['again']);
      }));

    it('stops everything on close and refuses later calls', async () => {
      const subject = await make();
      const { pubsub } = subject;
      const channel = freshChannel();
      const { messages, unsubscribe } = await listen(pubsub, channel);
      await pubsub.close();
      await pubsub.close();
      await unsubscribe();
      await expect(pubsub.publish(channel, 'x')).rejects.toMatchObject({ code: 'closed' });
      await expect(pubsub.subscribe(channel, ignore)).rejects.toMatchObject({ code: 'closed' });
      if (shared) {
        const other = await make();
        try {
          await other.pubsub.publish(channel, 'from another instance');
          await sleep(settleMs);
        } finally {
          await other.pubsub.close();
        }
      }
      expect(messages).toEqual([]);
    });

    if (shared) {
      it('delivers between two instances on the same transport', async () => {
        const listener = await make();
        const publisher = await make();
        try {
          const channel = freshChannel();
          const { messages } = await listen(listener.pubsub, channel);
          await publisher.pubsub.publish(channel, 'across');
          await until(() => messages.length === 1, 'the message from the other instance');
          expect(messages).toEqual(['across']);
        } finally {
          await listener.pubsub.close();
          await publisher.pubsub.close();
        }
      });
    }

    it('refuses bad channels and payloads that are too long', () =>
      withSubject(async ({ pubsub }) => {
        for (const channel of ['', 'Upper', 'has-dash', 'has space', 'a'.repeat(64)]) {
          await expect(pubsub.publish(channel, 'x')).rejects.toBeInstanceOf(PubSubError);
          await expect(pubsub.publish(channel, 'x')).rejects.toMatchObject({ code: 'channel' });
          await expect(pubsub.subscribe(channel, ignore)).rejects.toMatchObject({ code: 'channel' });
        }
        const channel = freshChannel();
        await expect(pubsub.publish(channel, 'x'.repeat(MAX_PAYLOAD_BYTES + 1))).rejects.toMatchObject({
          code: 'payload',
        });
        // Bytes, not characters: `é` is two bytes in UTF-8.
        await expect(pubsub.publish(channel, 'é'.repeat(Math.floor(MAX_PAYLOAD_BYTES / 2) + 1))).rejects.toMatchObject({
          code: 'payload',
        });
        // The largest channel and payload go through.
        const longest = `${channel}_${'z'.repeat(63 - channel.length - 1)}`;
        const { messages } = await listen(pubsub, longest);
        const biggest = 'y'.repeat(MAX_PAYLOAD_BYTES);
        await pubsub.publish(longest, biggest);
        await until(() => messages.length === 1, 'the largest message');
        expect(messages[0]).toBe(biggest);
      }));

    it('publishIn delivers only after the transaction commits', context =>
      withSubject(async subject => {
        if (!('transaction' in subject)) return context.skip('no publishIn on this backend');
        const { pubsub, transaction } = subject;
        const channel = freshChannel();
        const { messages } = await listen(pubsub, channel);
        await transaction(async tx => {
          await pubsub.publishIn(tx, channel, 'committed');
          await sleep(settleMs);
          expect(messages).toEqual([]);
        });
        await until(() => messages.length === 1, 'the committed message');
        expect(messages).toEqual(['committed']);
      }));

    it('publishIn never delivers a rolled-back message', context =>
      withSubject(async subject => {
        if (!('transaction' in subject)) return context.skip('no publishIn on this backend');
        const { pubsub, transaction } = subject;
        const channel = freshChannel();
        const { messages } = await listen(pubsub, channel);
        await expect(
          transaction(async tx => {
            await pubsub.publishIn(tx, channel, 'rolled back');
            throw new Rollback('roll back');
          }),
        ).rejects.toBeInstanceOf(Rollback);
        await pubsub.publish(channel, 'after');
        await until(() => messages.includes('after'), 'the message after the rollback');
        await sleep(settleMs);
        expect(messages).toEqual(['after']);
      }));

    it('publishIn refuses bad channels and payloads too', context =>
      withSubject(async subject => {
        if (!('transaction' in subject)) return context.skip('no publishIn on this backend');
        const { pubsub, transaction } = subject;
        await transaction(async tx => {
          await expect(pubsub.publishIn(tx, 'Bad', 'x')).rejects.toMatchObject({ code: 'channel' });
          await expect(pubsub.publishIn(tx, freshChannel(), 'x'.repeat(MAX_PAYLOAD_BYTES + 1))).rejects.toMatchObject({
            code: 'payload',
          });
        });
      }));
  });
}
