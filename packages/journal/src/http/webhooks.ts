/**
 * Outgoing webhooks on the journal's job table: `@arki/journal/http/webhooks`.
 *
 * ```ts
 * export const webhookSchema = webhookTables();
 * export const webhooks = webhookSender({ tables, webhooks: webhookSchema, encryptionKey: env.WEBHOOK_KEY });
 *
 * // In the business transaction: the message exists if and only if the order commits.
 * await db.transaction(async tx => {
 *   await journal.run(tx, placeOrder, input, meta);
 *   await webhooks.dispatch(tx, { partner: tenantId, event: 'order.placed', payload: { orderId } });
 * });
 *
 * journal.worker(db, { jobs: webhooks.runner });
 * ```
 *
 * `dispatch` writes the message once and one `queue` row per active subscription, in the
 * caller's transaction. The journal worker runs each row: it signs the stored bytes with
 * Standard Webhooks and posts them. Retries, backoff, dead letters and `journal.retry` are the
 * worker's; this module adds no second retry loop. Every try is appended to `webhook_attempts`.
 * A subscription whose deliveries die `disableAfter` times in a row is disabled.
 *
 * Secrets are sealed at rest with AES-GCM under `encryptionKey`, bound to their subscription id.
 * Delivery goes through `publicFetch()` by default, so a subscriber URL cannot reach a private
 * address, at subscribe time or after a DNS change. A refused URL (`UnsafeUrl`, the cause of the error `publicFetch` rejects with) is dead at
 * once: it is refused the same way on every try, so retrying it only fills `webhook_attempts`.
 */
import type { PgSchema, PgTableFn } from 'drizzle-orm/pg-core';
import { and, arrayContains, eq, sql } from 'drizzle-orm';
import { bigserial, getTableConfig, index, integer, pgTable, text, timestamp, varchar } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import type { IdGenerationFailure } from '@arki/contracts';
import type { Backoff } from '@arki/resilience';
import { defineId } from '@arki/contracts';
import { findCause, isFailure } from '@arki/failure';
import { publicFetch, UnsafeUrl, validatePublicURL } from '@arki/http/public-fetch';
import { standardWebhooks } from '@arki/http/webhooks';
import { backoff } from '@arki/resilience';

import type { JournalTables } from '../pg.js';
import type { DbHandle, JobRunner, RootDb, ScheduledJob } from '../types.js';
import { jobId } from '../id.js';
import { rollbackOnFailure } from '../rollback.js';

const subscriptionId = defineId('whs_');
const webhookMessageId = defineId('msg_');

/** Stable codes for {@link WebhookError}. Match on codes, never parse messages. */
export const WEBHOOK_ERROR_CODES = {
  /** An input failed its schema, a payload is not JSON, or a URL is not public https.
   * @fix Validate the webhook input and JSON payload; use a public HTTPS destination.
   * @verify bun run test -- src/http/webhooks.test.ts
   */
  badInput: 'ARKI_JOURNAL_WEBHOOK_E001',
  /** `dispatch` got the root database. It needs the business transaction.
   * @fix Dispatch inside the business database transaction and pass its transaction handle.
   * @verify bun run test -- src/http/webhooks.test.ts
   */
  notInTransaction: 'ARKI_JOURNAL_WEBHOOK_E002',
  /** No subscription or message has this id.
   * @fix Check the subscription or message id and use an existing record.
   * @verify bun run test -- src/http/webhooks.test.ts
   */
  notFound: 'ARKI_JOURNAL_WEBHOOK_E003',
  /** `replay` named a message and a subscription of different partners.
   * @fix Replay only to a subscription owned by the same partner as the message.
   * @verify bun run test -- src/http/webhooks.test.ts
   */
  otherPartner: 'ARKI_JOURNAL_WEBHOOK_E004',
  /** `encryptionKey` is not 32 bytes of base64.
   * @fix Configure encryptionKey as a base64-encoded 32-byte key.
   * @verify bun run test -- src/http/webhooks.test.ts
   */
  badEncryptionKey: 'ARKI_JOURNAL_WEBHOOK_E005',
  /** The subscriber answered with a status other than 2xx. The worker retries it.
   * @fix Inspect the subscriber response and restore its successful 2xx handling; let the worker retry delivery.
   * @verify bun run test -- src/http/webhooks.test.ts
   */
  deliveryFailed: 'ARKI_JOURNAL_WEBHOOK_E006',
} as const;

export class WebhookError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(`webhooks: ${message}`, options);
    this.name = 'WebhookError';
    this.code = code;
  }
}

/**
 * The webhook tables. Call this once in the app's schema module, next to `journalTables()`,
 * so `drizzle-kit generate` creates them. The library never creates tables at runtime.
 */
export function webhookTables(schema?: PgSchema) {
  const table: PgTableFn<string | undefined> = schema === undefined ? pgTable : schema.table;

  const subscriptions = table(
    'webhook_subscriptions',
    {
      /** `whs_xxx`. */
      id: varchar('id').primaryKey(),
      /** Whose events this endpoint receives: a tenant, an account. `dispatch` matches on it. */
      partner: varchar('partner', { length: 256 }).notNull(),
      url: text('url').notNull(),
      /** The event names it receives, matched exactly. */
      events: text('events').array().notNull(),
      /** The signing secret, sealed with AES-GCM: base64 of IV and ciphertext. Never the plain secret. */
      secret: text('secret').notNull(),
      /** 1, then one more per `rotateSecret`. */
      secretVersion: integer('secret_version').notNull().default(1),
      /** The secret before the last rotation, sealed. Signs too until `previous_secret_until`. */
      previousSecret: text('previous_secret'),
      previousSecretUntil: timestamp('previous_secret_until', { withTimezone: true, mode: 'date' }),
      status: varchar('status', { length: 16 }).notNull().default('active').$type<'active' | 'disabled'>(),
      /** Deliveries that died in a row. A success resets it; `disableAfter` of them disables. */
      deadLetters: integer('dead_letters').notNull().default(0),
      disabledAt: timestamp('disabled_at', { withTimezone: true, mode: 'date' }),
      createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    },
    t => [index('webhook_subscriptions_partner_idx').on(t.partner)],
  );

  const messages = table('webhook_messages', {
    /** `msg_xxx`. Sent as `webhook-id`, the same on every retry and replay, so receivers dedupe on it. */
    id: varchar('id').primaryKey(),
    partner: varchar('partner', { length: 256 }).notNull(),
    event: varchar('event', { length: 128 }).notNull(),
    /** The exact body every delivery sends and signs, written once. */
    payload: text('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  });

  const attempts = table(
    'webhook_attempts',
    {
      seq: bigserial('seq', { mode: 'number' }).primaryKey(),
      messageId: varchar('message_id')
        .notNull()
        .references(() => messages.id),
      subscriptionId: varchar('subscription_id')
        .notNull()
        .references(() => subscriptions.id),
      /** The worker's try number for this delivery job, 1 first. */
      attempt: integer('attempt').notNull(),
      /** `failed` will be retried at `next_at`; `dead` will not; `skipped`: the subscription was disabled. */
      status: varchar('status', { length: 16 }).notNull().$type<'delivered' | 'failed' | 'dead' | 'skipped'>(),
      responseStatus: integer('response_status'),
      error: text('error'),
      nextAt: timestamp('next_at', { withTimezone: true, mode: 'date' }),
      at: timestamp('at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    },
    t => [index('webhook_attempts_message_id_idx').on(t.messageId)],
  );

  return { subscriptions, messages, attempts };
}

export type WebhookTables = ReturnType<typeof webhookTables>;

/** A transaction: it has `rollback()`, which the root database does not. */
export type WebhookTx = DbHandle & { rollback(): never };

export type WebhookSenderOptions = {
  readonly tables: Pick<JournalTables, 'jobs'>;
  readonly webhooks: WebhookTables;
  /** 32 random bytes as base64. Seals the signing secrets at rest; keep it out of the database. */
  readonly encryptionKey: string;
  /** Default `publicFetch()` from `@arki/http/public-fetch`: public addresses only, DNS checked and pinned. */
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
  /** One delivery try, in milliseconds. Default 10 000. */
  readonly timeoutMs?: number;
  /** When a failed delivery is tried again, and when it is dead. Default: from 5 s doubling to 1 h, 10 retries. A refused URL is never retried. */
  readonly retry?: Backoff;
  /** Dead deliveries in a row that disable a subscription. Default 5. */
  readonly disableAfter?: number;
  /** The largest body `dispatch` accepts, in bytes. It is sent to every subscriber on every try. Default 1 MiB. */
  readonly maxPayloadBytes?: number;
};

const DELIVER_JOB = 'webhook.deliver.v1';
const WAKE_PAYLOAD = '{"queue":1}';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const ERROR_TEXT_LIMIT = 1000;

/** A new endpoint: whose events it gets, where, and which ones. */
export type SubscribeInput = { readonly partner: string; readonly url: string; readonly events: readonly string[] };
/** One event for a partner's subscribers. `payload` must be JSON. */
export type DispatchInput = { readonly partner: string; readonly event: string; readonly payload: unknown };

// Annotated with the types above, so a schema cannot drift from the type it checks.
const subscribeInput: z.ZodType<SubscribeInput> = z.object({
  partner: z.string().min(1).max(256),
  url: z.url(),
  events: z.array(z.string().min(1).max(128)).min(1),
});
const dispatchInput: z.ZodType<DispatchInput> = z.object({
  partner: z.string().min(1).max(256),
  event: z.string().min(1).max(128),
  payload: z.unknown(),
});
const deliveryArgs = z.object({ messageId: z.string(), subscriptionId: z.string() });

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const toBase64 = (bytes: Uint8Array): string => btoa(Array.from(bytes, byte => String.fromCodePoint(byte)).join(''));
const fromBase64 = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(text), char => char.codePointAt(0) ?? 0);

const errorText = (error: unknown): string =>
  (isFailure(error) ? error.code : error instanceof Error ? error.message : String(error)).slice(0, ERROR_TEXT_LIMIT);

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new WebhookError(WEBHOOK_ERROR_CODES.badInput, `${what}: ${parsed.error.message}`);
  return parsed.data;
}

const requireRow = (found: readonly unknown[], what: string, id: string): void => {
  if (found.length === 0) throw new WebhookError(WEBHOOK_ERROR_CODES.notFound, `no ${what} ${id}`);
};

/** Each secret signs the same id and time; Standard Webhooks sends the signatures space-separated. */
const signedHeaders = async (
  secrets: readonly string[],
  id: string,
  payload: string,
) => {
  const timestamp = Math.floor(Date.now() / 1000);
  const signed: Headers[] = [];
  for (const secret of secrets) {
    const headers = await standardWebhooks({ secrets: [secret] }).sign(payload, { id, timestamp });
    if (isFailure(headers)) return headers;
    signed.push(headers);
  }
  return {
    'content-type': 'application/json',
    'webhook-id': id,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': signed.flatMap(headers => headers.get('webhook-signature') ?? []).join(' '),
  };
};

/** The sending side of webhooks. Build it once per app. */
export function webhookSender(options: WebhookSenderOptions) {
  const { subscriptions, messages, attempts } = options.webhooks;
  const { jobs } = options.tables;
  const send = options.fetch ?? publicFetch();
  const timeoutMs = options.timeoutMs ?? 10_000;
  const retry = options.retry ?? backoff.exponential({ base: 5000, max: 3_600_000, jitter: 0.25 }).upTo(10);
  /** The wait before the next try, or `undefined` for dead. A refused URL is dead whatever `retry` says. */
  const nextDelay = (attempt: number, error: unknown) =>
    findCause(error, UnsafeUrl) === undefined ? retry.delay(attempt, error) : undefined;
  const disableAfter = options.disableAfter ?? 5;
  const maxPayloadBytes = options.maxPayloadBytes ?? 1_048_576;
  // The journal's wake channel: every journal worker of this table hears it.
  const tableSchema = getTableConfig(jobs).schema;
  const channel = tableSchema === undefined ? 'journal_wake' : `${tableSchema}_journal_wake`;

  let keyBytes: Uint8Array<ArrayBuffer>;
  try {
    keyBytes = fromBase64(options.encryptionKey);
  } catch {
    keyBytes = new Uint8Array(0);
  }
  if (keyBytes.length !== KEY_BYTES) {
    throw new WebhookError(WEBHOOK_ERROR_CODES.badEncryptionKey, `encryptionKey must be ${KEY_BYTES} bytes of base64`);
  }
  let imported: Promise<CryptoKey> | undefined;
  const aesKey = (): Promise<CryptoKey> =>
    (imported ??= crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']));

  /** The subscription id is the associated data: a sealed secret copied onto another row does not open. */
  const seal = async (subscriptionId: string, plain: string): Promise<string> => {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: encoder.encode(subscriptionId) },
        await aesKey(),
        encoder.encode(plain),
      ),
    );
    const out = new Uint8Array(IV_BYTES + sealed.length);
    out.set(iv);
    out.set(sealed, IV_BYTES);
    return toBase64(out);
  };
  const open = async (subscriptionId: string, sealedText: string): Promise<string> => {
    const bytes = fromBase64(sealedText);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, IV_BYTES), additionalData: encoder.encode(subscriptionId) },
      await aesKey(),
      bytes.slice(IV_BYTES),
    );
    return decoder.decode(plain);
  };
  const newSecret = (): string => `whsec_${toBase64(crypto.getRandomValues(new Uint8Array(KEY_BYTES)))}`;

  const enqueue = async (
    db: DbHandle,
    messageId: string,
    subscriptionIds: readonly string[],
  ): Promise<string[] | IdGenerationFailure> => {
    if (subscriptionIds.length === 0) return [];
    const rows: (typeof jobs.$inferInsert)[] = [];
    const ids: string[] = [];
    for (const subscriptionId of subscriptionIds) {
      const id = jobId();
      if (isFailure(id)) return id;
      ids.push(id);
      rows.push({ id, kind: 'queue', jobName: DELIVER_JOB, args: { messageId, subscriptionId } });
    }
    await db.insert(jobs).values(rows);
    // Delivered at commit, dropped on rollback.
    await db.execute(sql`select pg_notify(${channel}, ${WAKE_PAYLOAD})`);
    return ids;
  };


  type Delivery = z.output<typeof deliveryArgs>;

  /** A failed try: retried later, or dead. A dead one counts toward disabling the subscription. */
  const recordFailure = async (
    db: RootDb,
    job: ScheduledJob,
    delivery: Delivery,
    responseStatus: number | undefined,
    error: unknown,
  ): Promise<void> => {
    const delay = nextDelay(job.attempt, error);
    await db.insert(attempts).values({
      ...delivery,
      attempt: job.attempt,
      status: delay === undefined ? 'dead' : 'failed',
      responseStatus: responseStatus ?? null,
      error: errorText(error),
      nextAt: delay === undefined ? null : new Date(Date.now() + delay),
    });
    if (delay !== undefined) return;
    // One statement, so two workers finishing at once still count both and disable once.
    const reached = sql`${subscriptions.deadLetters} + 1 >= ${disableAfter}`;
    await db
      .update(subscriptions)
      .set({
        deadLetters: sql`${subscriptions.deadLetters} + 1`,
        status: sql`case when ${reached} then 'disabled' else ${subscriptions.status} end`,
        disabledAt: sql`case when ${reached} then coalesce(${subscriptions.disabledAt}, now()) else ${subscriptions.disabledAt} end`,
      })
      .where(eq(subscriptions.id, delivery.subscriptionId));
  };

  const runner = {
    names: [DELIVER_JOB],
    run: async (job, { db, signal }) => {
      const delivery = deliveryArgs.parse(job.args);
      const [message] = await db
        .select({ payload: messages.payload })
        .from(messages)
        .where(eq(messages.id, delivery.messageId));
      const [subscription] = await db
        .select({
          url: subscriptions.url,
          status: subscriptions.status,
          secret: subscriptions.secret,
          previousSecret: subscriptions.previousSecret,
          previousSecretUntil: subscriptions.previousSecretUntil,
        })
        .from(subscriptions)
        .where(eq(subscriptions.id, delivery.subscriptionId));
      // Deleted on purpose: there is nothing left to send.
      if (message === undefined || subscription === undefined) return;
      if (subscription.status !== 'active') {
        await db.insert(attempts).values({ ...delivery, attempt: job.attempt, status: 'skipped' });
        return;
      }

      const secrets = [await open(delivery.subscriptionId, subscription.secret)];
      const { previousSecret, previousSecretUntil } = subscription;
      if (previousSecret !== null && previousSecretUntil !== null && previousSecretUntil > new Date()) {
        secrets.push(await open(delivery.subscriptionId, previousSecret));
      }
      const headers = await signedHeaders(secrets, delivery.messageId, message.payload);
      if (isFailure(headers)) {
        await recordFailure(db, job, delivery, undefined, headers);
        return headers;
      }

      let response: Response;
      try {
        response = await send(subscription.url, {
          method: 'POST',
          headers,
          body: message.payload,
          signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        });
      } catch (error) {
        await recordFailure(db, job, delivery, undefined, error);
        throw error;
      }
      // Only the status matters; free the connection.
      await response.body?.cancel().catch(() => null);
      if (response.ok) {
        await db.insert(attempts).values({
          ...delivery,
          attempt: job.attempt,
          status: 'delivered',
          responseStatus: response.status,
        });
        await db.update(subscriptions).set({ deadLetters: 0 }).where(eq(subscriptions.id, delivery.subscriptionId));
        return;
      }
      const error = new WebhookError(
        WEBHOOK_ERROR_CODES.deliveryFailed,
        `subscription ${delivery.subscriptionId} answered ${response.status}`,
      );
      await recordFailure(db, job, delivery, response.status, error);
      throw error;
    },
    retryDelay: (job, error) => nextDelay(job.attempt, error),
  } satisfies JobRunner;

  return {
    /** The runner for `journal.worker(db, { jobs })`; combine it with others through `combineRunners`. */
    runner,

    /**
     * Adds an endpoint for a partner's events and returns its signing secret, the only time it
     * is readable: show it to the partner once. The URL must be public https.
     */
    subscribe: async (
      db: DbHandle,
      input: SubscribeInput,
    ): Promise<{ id: string; secret: string } | IdGenerationFailure> => {
      const { partner, url, events } = parse(subscribeInput, input, 'subscribe');
      if (new URL(url).protocol !== 'https:') {
        throw new WebhookError(WEBHOOK_ERROR_CODES.badInput, 'subscribe: the URL must use https');
      }
      const checked = validatePublicURL(url);
      if (isFailure(checked)) {
        throw new WebhookError(WEBHOOK_ERROR_CODES.badInput, `subscribe: ${checked.message}`, { cause: checked });
      }
      const id = subscriptionId.create();
      if (isFailure(id)) return id;
      const secret = newSecret();
      await db.insert(subscriptions).values({ id, partner, url, events: [...events], secret: await seal(id, secret) });
      return { id, secret };
    },

    /**
     * Writes the message and one delivery per active subscription of this partner and event, in
     * `tx`. A rollback removes them with the business write. The payload is stored once, as the
     * body `{ type, timestamp, data }` every delivery sends.
     */
    dispatch: async (
      tx: WebhookTx,
      input: DispatchInput,
    ): Promise<{ messageId: string; deliveries: number } | IdGenerationFailure> => {
      // The type already refuses the root database; this catches untyped callers.
      if (typeof Reflect.get(tx, 'rollback') !== 'function') {
        throw new WebhookError(
          WEBHOOK_ERROR_CODES.notInTransaction,
          'dispatch got the root database; pass the business transaction, so the message commits with it',
        );
      }
      const { partner, event, payload } = parse(dispatchInput, input, 'dispatch');
      let body: string | undefined;
      try {
        body = JSON.stringify({ type: event, timestamp: new Date().toISOString(), data: payload });
      } catch (error) {
        throw new WebhookError(WEBHOOK_ERROR_CODES.badInput, `dispatch: the payload is not JSON: ${errorText(error)}`);
      }
      const size = encoder.encode(body).length;
      if (size > maxPayloadBytes) {
        throw new WebhookError(
          WEBHOOK_ERROR_CODES.badInput,
          `dispatch: the body is ${size} bytes, over maxPayloadBytes (${maxPayloadBytes})`,
        );
      }
      const messageId = webhookMessageId.create();
      if (isFailure(messageId)) return messageId;
      const refusal = rollbackOnFailure<{ messageId: string; deliveries: number } | IdGenerationFailure>();
      return tx
        .transaction(async tx => {
          await tx.insert(messages).values({ id: messageId, partner, event, payload: body });
          const targets = await tx
            .select({ id: subscriptions.id })
            .from(subscriptions)
            .where(
              and(
                eq(subscriptions.partner, partner),
                eq(subscriptions.status, 'active'),
                arrayContains(subscriptions.events, [event]),
              ),
            );
          const queued = await enqueue(
            tx,
            messageId,
            targets.map(target => target.id),
          );
          if (isFailure(queued)) return refusal.settle(queued);
          return { messageId, deliveries: queued.length };
        })
        .catch(refusal.recover);
    },

    /**
     * Sends a stored message again to one subscription of the same partner, with the same
     * `webhook-id`. A disabled subscription records the try as skipped: `enable` it first.
     */
    replay: async (
      db: DbHandle,
      input: { messageId: string; subscriptionId: string },
    ): Promise<{ jobId: string } | IdGenerationFailure> => {
      const message = await db
        .select({ partner: messages.partner })
        .from(messages)
        .where(eq(messages.id, input.messageId));
      requireRow(message, 'message', input.messageId);
      const subscription = await db
        .select({ partner: subscriptions.partner })
        .from(subscriptions)
        .where(eq(subscriptions.id, input.subscriptionId));
      requireRow(subscription, 'subscription', input.subscriptionId);
      if (message[0]?.partner !== subscription[0]?.partner) {
        throw new WebhookError(
          WEBHOOK_ERROR_CODES.otherPartner,
          `message ${input.messageId} and subscription ${input.subscriptionId} belong to different partners`,
        );
      }
      const result = await enqueue(db, input.messageId, [input.subscriptionId]);
      if (isFailure(result)) return result;
      const [queued] = result;
      if (queued === undefined) throw new WebhookError(WEBHOOK_ERROR_CODES.notFound, 'replay queued nothing');
      return { jobId: queued };
    },

    /**
     * A new signing secret. The old one keeps signing too for `windowSeconds` (default a day),
     * so the partner can switch without dropping a message. Returns the new secret once.
     */
    rotateSecret: async (
      db: DbHandle,
      subscriptionId: string,
      rotation: { readonly windowSeconds?: number } = {},
    ): Promise<{ secret: string }> => {
      const windowSeconds = rotation.windowSeconds ?? 86_400;
      const secret = newSecret();
      const updated = await db
        .update(subscriptions)
        .set({
          // The right side reads the row before this update: the current secret becomes the previous one.
          previousSecret: sql`${subscriptions.secret}`,
          previousSecretUntil: sql`now() + make_interval(secs => ${windowSeconds})`,
          secret: await seal(subscriptionId, secret),
          secretVersion: sql`${subscriptions.secretVersion} + 1`,
        })
        .where(eq(subscriptions.id, subscriptionId))
        .returning({ id: subscriptions.id });
      requireRow(updated, 'subscription', subscriptionId);
      return { secret };
    },

    /** Turns a subscription back on and clears its dead-letter count. */
    enable: async (db: DbHandle, subscriptionId: string): Promise<void> => {
      const updated = await db
        .update(subscriptions)
        .set({ status: 'active', deadLetters: 0, disabledAt: null })
        .where(eq(subscriptions.id, subscriptionId))
        .returning({ id: subscriptions.id });
      requireRow(updated, 'subscription', subscriptionId);
    },

    /** Stops deliveries: new messages skip it, queued ones record `skipped`. */
    disable: async (db: DbHandle, subscriptionId: string): Promise<void> => {
      const updated = await db
        .update(subscriptions)
        .set({ status: 'disabled', disabledAt: sql`coalesce(${subscriptions.disabledAt}, now())` })
        .where(eq(subscriptions.id, subscriptionId))
        .returning({ id: subscriptions.id });
      requireRow(updated, 'subscription', subscriptionId);
    },
  };
}

export type WebhookSender = ReturnType<typeof webhookSender>;
