/**
 * Receipts: what a client gets instead of a Postgres transaction id.
 *
 * A raw `xid8` is one counter for the whole database. The gap between two ids
 * a client sees tells it how many transactions ran in between, on every
 * table, granted or not. A receipt is an HMAC of the id under the app's
 * secret, cut to 22 base64url characters (132 bits): one length, no order,
 * nothing to subtract. A client only compares receipts: `awaitTxId` waits
 * for a frame that names the receipt its own mutation returned.
 *
 *     receipt(xid8) = base64url(HMAC-SHA256(secret, "arki-live/v1|" + app + "|" + xid8))[0..22]
 *
 * Every instance of an app uses the same secret (like a session secret), so a
 * mutation served by one instance matches a frame sent by another. Needs
 * WebCrypto (`crypto.subtle`): Node 20+, Bun, Deno, browsers.
 */
import { z } from 'zod';

import type { LiveReceipt } from './types.js';
import { toBase64Url } from './cursor.js';
import { LIVE_ERROR_CODES, liveError } from './errors.js';
import { txIdSchema } from './schema.js';

/** Turns transaction ids into receipts. One per app, shared by the hub and the mutations. */
export type LiveReceipts = {
  /**
   * The receipt of transaction `txid`: `pg_current_xact_id()::text`, read inside that
   * transaction. Rejects with E004 when `txid` is not a transaction id.
   */
  of(txid: string): Promise<LiveReceipt>;
};

/** HMAC-SHA256 gives 32 bytes (43 characters); 22 characters keep 132 bits. */
const RECEIPT_LENGTH = 22;
/** A domain prefix with a version, so a receipt never equals an HMAC made for something else with this secret. */
const PREFIX = 'arki-live/v1|';

const optionsSchema = z
  .object({
    /** The app's name, as given to `pgSource` and `liveMigration`. */
    app: z.string().min(1),
    /** At least 32 characters, e.g. `openssl rand -base64 32`. The same on every instance of the app. */
    secret: z.string().min(32),
  })
  .strict();

/** WebCrypto, or `undefined` on an engine without it (the global types say it is always there). */
function subtleOf(crypto: { readonly subtle?: Crypto['subtle'] } | undefined): Crypto['subtle'] | undefined {
  return crypto?.subtle;
}

/**
 * Receipts under `secret` for app `app`. Throws E001 for a missing app, a secret shorter than 32
 * characters, or an engine without WebCrypto, so a server that would leak raw ids never starts.
 */
export function liveReceipts(options: { readonly app: string; readonly secret: string }): LiveReceipts {
  const parsed = optionsSchema.safeParse(options);
  if (!parsed.success) {
    throw liveError(
      LIVE_ERROR_CODES.config,
      `liveReceipts(): bad options: ${parsed.error.message}`,
      'Pass the app name and a secret of at least 32 characters from the app config (make one with `openssl rand -base64 32`).',
    );
  }
  const subtle = subtleOf(globalThis.crypto);
  if (subtle === undefined) {
    throw liveError(
      LIVE_ERROR_CODES.config,
      'liveReceipts() needs WebCrypto (crypto.subtle) to make receipts',
      'Run the server where crypto.subtle exists (Node 20+, Bun, Deno). Clients never need it.',
    );
  }
  const { app, secret } = parsed.data;
  const encoder = new TextEncoder();
  const importKey = () =>
    subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  let key: ReturnType<typeof importKey> | undefined;

  return {
    async of(txid) {
      if (!txIdSchema.safeParse(txid).success) {
        throw liveError(
          LIVE_ERROR_CODES.protocol,
          `liveReceipts().of(${JSON.stringify(txid)}): not a transaction id`,
          "Pass pg_current_xact_id()::text of the mutation's own transaction, read inside that transaction.",
        );
      }
      key ??= importKey();
      const mac = await subtle.sign('HMAC', await key, encoder.encode(`${PREFIX}${app}|${txid}`));
      return toBase64Url(new Uint8Array(mac)).slice(0, RECEIPT_LENGTH);
    },
  };
}
