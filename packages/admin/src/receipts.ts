/**
 * Execution receipts: what the app records about every execute, keyed by the
 * permit's `executionId`, so Foreman can settle an execute whose answer was lost.
 *
 * The dispatcher, for each execute:
 *  1. claims the execution id (a `pending` receipt, stored before the action runs);
 *  2. runs the action;
 *  3. settles the receipt (`applied` or `failed`) before it sends the response.
 *
 * A second execute with the same id never runs the action again: it gets the
 * stored outcome, or `ARKI_ADMIN_E018` while the receipt is still `pending`.
 * A `pending` receipt that never settles (the process died mid-action) stays
 * `pending`: Foreman reads it as "unavailable", so the outcome stays unknown and
 * is never guessed.
 *
 * `core.receipts.get` (read scope `core:read`) answers with the stored receipt,
 * or `not_applied` when this app holds none. Foreman alone decides when
 * `not_applied` is final: only after its receipt window, when the request can
 * no longer land.
 *
 * Two stores: {@link kvReceiptStore} here (any `@arki/kv` `KV`), and
 * `journalReceiptStore` in `@arki/journal/foreman` (Postgres through `@arki/journal`).
 */
import { z } from '@arki/contracts';

import type { ForemanModule } from './module';
import { ADMIN_ERROR_CODES, AdminError } from './errors';
import { jsonValueSchema } from './json';
import { defineModule, defineRead } from './module';
import { audienceSchema, executionIdSchema } from './protocol';

export const RECEIPTS_MODULE_ID = 'core.receipts';
/** The read Foreman calls to settle a lost execute answer. */
export const RECEIPTS_READ_ID = 'core.receipts.get';
/** Same as `CORE_PERMISSION`: Foreman signs receipt lookups with the core read scope. */
export const RECEIPTS_PERMISSION = 'core:read';
export const RECEIPTS_MODULE_VERSION = '1.0.0';

/**
 * Foreman's receipt window (`DEFAULT_RECEIPT_WINDOW_MS` in its approval engine):
 * after it, "no receipt" means "not applied". A store must keep receipts at
 * least this long; it should keep them far longer, because Foreman may settle
 * an execution long after the window.
 */
export const RECEIPT_WINDOW_SECONDS = 5 * 60;
/** How long {@link kvReceiptStore} keeps a receipt unless told otherwise: 30 days. */
export const DEFAULT_RECEIPT_TTL_SECONDS = 30 * 24 * 60 * 60;

const isoSchema = z.iso.datetime({ offset: true });
const actionIdSchema = z.string().min(1).max(256);
/**
 * SHA-256 (`sha256:<hex>`) over the canonical JSON of the signed operation:
 * audience, method, path, body hash and permit. A repeat answers from the
 * receipt only when its hash matches. Absent on receipts written before it
 * existed; those are matched by action id alone.
 */
const requestHashSchema = z
  .string()
  .regex(/^sha256:[\da-f]{64}$/)
  .optional();

/** Claimed, not settled: the action is running, or stopped before it recorded an outcome. */
export const pendingReceiptSchema = z.object({
  status: z.literal('pending'),
  executionId: executionIdSchema,
  actionId: actionIdSchema,
  requestHash: requestHashSchema,
  claimedAt: isoSchema,
});

/**
 * The action ran and returned. `result` is the data the execute answered with (JSON),
 * and `resultHash` its SHA-256 over canonical JSON (`sha256:<hex>`). When the action ran but returned
 * data its own schema rejects (`ARKI_ADMIN_E005`), `result` is `null` and there is no hash.
 */
export const appliedReceiptSchema = z.object({
  status: z.literal('applied'),
  executionId: executionIdSchema,
  actionId: actionIdSchema,
  requestHash: requestHashSchema,
  claimedAt: isoSchema,
  appliedAt: isoSchema,
  result: jsonValueSchema,
  resultHash: z
    .string()
    .regex(/^sha256:[\da-f]{64}$/)
    .optional(),
});

/** The action threw. `error` is exactly what the execute answered with: a code and a wire-safe message. */
export const failedReceiptSchema = z.object({
  status: z.literal('failed'),
  executionId: executionIdSchema,
  actionId: actionIdSchema,
  requestHash: requestHashSchema,
  claimedAt: isoSchema,
  failedAt: isoSchema,
  error: z.object({
    code: z.string().min(1).max(64),
    message: z.string().max(2000),
    /** Set for a module's own error, so a repeat answers the same status. */
    status: z.number().int().min(400).max(599).optional(),
  }),
});

export const settledReceiptSchema = z.discriminatedUnion('status', [appliedReceiptSchema, failedReceiptSchema]);
export const storedReceiptSchema = z.discriminatedUnion('status', [
  pendingReceiptSchema,
  appliedReceiptSchema,
  failedReceiptSchema,
]);

/** What `core.receipts.get` answers: the stored receipt, or `not_applied` when there is none. */
export const receiptAnswerSchema = z.discriminatedUnion('status', [
  pendingReceiptSchema,
  appliedReceiptSchema,
  failedReceiptSchema,
  z.object({ status: z.literal('not_applied'), executionId: executionIdSchema }),
]);

export type PendingReceipt = z.output<typeof pendingReceiptSchema>;
export type SettledReceipt = z.output<typeof settledReceiptSchema>;
export type StoredReceipt = z.output<typeof storedReceiptSchema>;
export type ReceiptAnswer = z.output<typeof receiptAnswerSchema>;

/** The answer to a claim: this call took the id, or someone already holds it (and what they recorded, if anything). */
export type ReceiptClaimResult =
  { readonly claimed: true } | { readonly claimed: false; readonly receipt: StoredReceipt | undefined };

/**
 * Where receipts live. Implementations must make `claim` atomic across app
 * instances: of many concurrent claims for one execution id, exactly one gets
 * `claimed: true`. `settle` is called only by that one claimer. Keep receipts
 * at least {@link RECEIPT_WINDOW_SECONDS}; longer is better.
 */
export type ReceiptStore = {
  claim(receipt: PendingReceipt): Promise<ReceiptClaimResult>;
  settle(receipt: SettledReceipt): Promise<void>;
  get(executionId: string): Promise<StoredReceipt | undefined>;
};

/**
 * The part of `@arki/kv` `KV` the receipt store uses. `setIfNotExists` takes the
 * claim (Redis `SET NX EX`, atomic); `get` and `set` hold the receipt itself.
 */
export type ReceiptKV = {
  get(key: string): Promise<unknown>;
  set(key: string, value: StoredReceipt, expirationSeconds?: number): Promise<boolean>;
  setIfNotExists(key: string, value: number, expirationSeconds: number): Promise<boolean>;
};

export type KvReceiptStoreOptions = {
  /**
   * Whose receipts these are: the app's audience, `slug:environment` (`shop:prod`).
   * Every key carries it, so two apps (or two environments) on one KV never read each other's receipts.
   */
  namespace: string;
  /** How long a receipt is kept. At least {@link RECEIPT_WINDOW_SECONDS}. Defaults to 30 days. */
  ttlSeconds?: number;
  /** Key prefix. Defaults to `arki:admin:receipt`. */
  prefix?: string;
};

const kvOptionsSchema = z.object({
  // The audience pattern allows only `[a-z0-9-]` around one `:`, so a namespace cannot carry a key separator of its own.
  namespace: audienceSchema,
  ttlSeconds: z.int().min(RECEIPT_WINDOW_SECONDS).optional(),
  prefix: z.string().min(1).optional(),
});

/**
 * A receipt store on `@arki/kv`, for plain apps. No transaction joins the action:
 * the claim and the settle each are one write. An action that throws after a
 * partial write is still recorded `failed`, so keep each action atomic.
 *
 * Throws `ARKI_ADMIN_E014` for a TTL shorter than Foreman's receipt window,
 * or a namespace that is not an audience.
 */
export function kvReceiptStore(kv: ReceiptKV, options: KvReceiptStoreOptions): ReceiptStore {
  const parsed = kvOptionsSchema.safeParse(options);
  if (!parsed.success) {
    throw new AdminError(
      ADMIN_ERROR_CODES.invalidConfig,
      `The receipt store options are invalid:\n${z.prettifyError(parsed.error)}`,
      `Pass the app's audience as namespace ("shop:prod"). Keep receipts at least ${String(RECEIPT_WINDOW_SECONDS)} s (Foreman's receipt window); the default is 30 days.`,
    );
  }
  const ttl = parsed.data.ttlSeconds ?? DEFAULT_RECEIPT_TTL_SECONDS;
  const { namespace } = parsed.data;
  const prefix = parsed.data.prefix ?? 'arki:admin:receipt';
  const claimKey = (executionId: string) => `${prefix}:${namespace}:claim:${executionId}`;
  const receiptKey = (executionId: string) => `${prefix}:${namespace}:value:${executionId}`;

  const get = async (executionId: string): Promise<StoredReceipt | undefined> => {
    const raw = await kv.get(receiptKey(executionId));
    if (raw === undefined || raw === null) return undefined;
    const receipt = storedReceiptSchema.safeParse(raw);
    if (!receipt.success || receipt.data.executionId !== executionId) {
      throw new AdminError(
        ADMIN_ERROR_CODES.handlerFailed,
        `The stored receipt for execution ${executionId} is not a receipt.`,
        'Inspect the receipt key in the KV store; something other than @arki/admin wrote it.',
        { cause: receipt.error },
      );
    }
    return receipt.data;
  };

  return {
    async claim(receipt) {
      if (!(await kv.setIfNotExists(claimKey(receipt.executionId), 1, ttl))) {
        return { claimed: false, receipt: await get(receipt.executionId) };
      }
      await kv.set(receiptKey(receipt.executionId), pendingReceiptSchema.parse(receipt), ttl);
      return { claimed: true };
    },
    async settle(receipt) {
      await kv.set(receiptKey(receipt.executionId), settledReceiptSchema.parse(receipt), ttl);
    },
    get,
  };
}

/** The `core.receipts` module: one read, `core.receipts.get`. `withCoreModules` adds it when given a store. */
export function receiptsModule<TCtx>(store: ReceiptStore): ForemanModule<TCtx> {
  return defineModule({
    id: RECEIPTS_MODULE_ID,
    version: RECEIPTS_MODULE_VERSION,
    reads: {
      get: defineRead({
        id: RECEIPTS_READ_ID,
        summary: 'What this app recorded for one execution: applied, failed, pending or not applied',
        permission: RECEIPTS_PERMISSION,
        input: z.strictObject({ executionId: executionIdSchema }),
        output: receiptAnswerSchema,
        load: async ({ executionId }): Promise<ReceiptAnswer> =>
          (await store.get(executionId)) ?? { status: 'not_applied', executionId },
      }),
    },
    actions: {},
  });
}
