/**
 * @internal Opaque cursors. Inside the hub a position is `(epoch, seq)`: the
 * epoch and the frame number. On the wire it is sealed with AES-GCM under a
 * random key the hub makes at `start()`, with a fresh random IV each time, so
 * every cursor a client sees has the same length and looks random. A client
 * cannot read the frame number, so it cannot count the frames it was not
 * shown (frames of tables its grant hides). Two seals of one position do not
 * even look equal. (The hub seals each `change` frame once and gives every
 * stream that cursor; see `hub.ts`.)
 *
 * Layout: base64url(iv[12] ‖ ciphertext[28] ‖ tag[16]) = 75 characters. The
 * plaintext is the 12 ASCII bytes of the epoch, the sequence and the time the
 * position was taken (ms since 1970), each a 64-bit big-endian integer. The
 * time decides resume or reset by age alone (`hub.ts`); the client knows it
 * anyway (it got the cursor then), and it stays sealed. A cursor that does not open (another hub's key, a
 * changed byte, a different length) is unknown: the hub resets it, as it does
 * a cursor of another epoch.
 *
 * Server-only in practice: clients keep the cursor as a string and never
 * parse it. Needs WebCrypto (`crypto.subtle`): Node 20+, Bun, Deno, browsers.
 */
import type { LiveCursor } from './types.js';
import { LIVE_ERROR_CODES, liveError } from './errors.js';

/** A place in a hub's frame sequence, and when it was taken (`Date.now()`). */
export type CursorPosition = { readonly epoch: string; readonly seq: number; readonly at: number };

export type CursorCipher = {
  /** A new opaque cursor for `position`: random IV, so two seals of one position differ. */
  seal(position: CursorPosition): Promise<LiveCursor>;
  /** The position inside `cursor`, or `undefined` when this hub did not seal it (or it was changed). */
  open(cursor: LiveCursor): Promise<CursorPosition | undefined>;
};

const IV_BYTES = 12;
const EPOCH_BYTES = 12;
const PLAIN_BYTES = EPOCH_BYTES + 16;
const SEALED_BYTES = IV_BYTES + PLAIN_BYTES + 16;
const TWO_TO_32 = 2 ** 32;

/** @internal Bytes as unpadded base64url: cursors and receipts. */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array | undefined {
  let binary: string;
  try {
    binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
  } catch {
    return undefined;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.codePointAt(index) ?? 0;
  return bytes;
}

/** A non-negative safe integer as 64-bit big-endian (no BigInt: every engine has this). */
function writeUint64(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, Math.floor(value / TWO_TO_32));
  view.setUint32(offset + 4, value % TWO_TO_32);
}

function readUint64(view: DataView, offset: number): number {
  return view.getUint32(offset) * TWO_TO_32 + view.getUint32(offset + 4);
}

/** Makes the hub's key. Rejects with E001 where WebCrypto is missing: a hub must not run with readable cursors. */
export async function cursorCipher(): Promise<CursorCipher> {
  let key: CryptoKey;
  try {
    key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  } catch (error) {
    throw liveError(
      LIVE_ERROR_CODES.config,
      `the live hub needs WebCrypto (crypto.subtle) to seal its cursors: ${error instanceof Error ? error.message : String(error)}`,
      'Run the hub where crypto.subtle exists (Node 20+, Bun, Deno). Clients never need it.',
    );
  }
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return {
    async seal({ epoch, seq, at }) {
      const plain = new Uint8Array(PLAIN_BYTES);
      plain.set(encoder.encode(epoch));
      const view = new DataView(plain.buffer);
      writeUint64(view, EPOCH_BYTES, seq);
      writeUint64(view, EPOCH_BYTES + 8, at);
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
      const out = new Uint8Array(IV_BYTES + sealed.length);
      out.set(iv);
      out.set(sealed, IV_BYTES);
      return toBase64Url(out);
    },

    async open(cursor) {
      const bytes = fromBase64Url(cursor);
      if (bytes?.length !== SEALED_BYTES) return;
      let plain: Uint8Array;
      try {
        const iv = bytes.slice(0, IV_BYTES);
        plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, bytes.slice(IV_BYTES)));
      } catch {
        return;
      }
      const view = new DataView(plain.buffer);
      return {
        epoch: decoder.decode(plain.subarray(0, EPOCH_BYTES)),
        seq: readUint64(view, EPOCH_BYTES),
        at: readUint64(view, EPOCH_BYTES + 8),
      };
    },
  };
}
