/**
 * A software passkey authenticator: a real ES256 key pair from WebCrypto, a real CBOR attestation
 * object (format `none`) and real `clientDataJSON`, signed the way a device signs. The engine
 * verifies its answers with the same checks it runs on a phone's answers. Node only (`Buffer`).
 */
import type { CBORType } from '@levischuck/tiny-cbor';
import { encodeCBOR } from '@levischuck/tiny-cbor';
import { z } from 'zod';

/** The part of the engine's ceremony options the authenticator reads. */
const ceremonyOptions = z.object({ challenge: z.string() });

/** Flags in the authenticator data: user present, user verified, attested credential data. */
const USER_PRESENT = 0x01;
const USER_VERIFIED = 0x04;
const ATTESTED_DATA = 0x40;

const encoder = new TextEncoder();
const base64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
const fromBase64url = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'base64url'));
const sha256 = async (bytes: BufferSource): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));

function concat(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function bigEndian(value: number, bytes: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out.slice(4 - bytes);
}

/** One DER INTEGER from a fixed-width unsigned value: leading zeros dropped, a sign byte added. */
function derInteger(value: Uint8Array): Uint8Array {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start += 1;
  const digits = value.slice(start);
  const body = (digits[0] ?? 0) >= 0x80 ? concat(new Uint8Array([0]), digits) : digits;
  return concat(new Uint8Array([0x02, body.length]), body);
}

/** WebCrypto signs ECDSA as `r || s`; WebAuthn sends the DER sequence. */
function derSignature(raw: Uint8Array): Uint8Array {
  const body = concat(derInteger(raw.slice(0, 32)), derInteger(raw.slice(32)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

/** A platform authenticator with one discoverable credential, answering for `origin`. */
export async function createSoftwareAuthenticator(origin: string) {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const credentialId = crypto.getRandomValues(new Uint8Array(16));
  const id = base64url(credentialId);
  const rpIdHash = await sha256(encoder.encode(new URL(origin).hostname));
  let counter = 0;

  const authenticatorData = (flags: number, attested: Uint8Array) =>
    concat(rpIdHash, new Uint8Array([flags]), bigEndian(counter, 4), attested);
  const clientData = (type: 'webauthn.create' | 'webauthn.get', options: unknown) =>
    encoder.encode(JSON.stringify({ type, challenge: ceremonyOptions.parse(options).challenge, origin }));

  return {
    /** The credential id the engine stores (`credentialID`). */
    id,
    /** Answers `navigator.credentials.create()` for the engine's registration options. */
    async register(options: unknown) {
      const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
      // COSE_Key: kty EC2 (1: 2), alg ES256 (3: -7), crv P-256 (-1: 1), x (-2), y (-3).
      const coseKey = encodeCBOR(
        new Map<number, CBORType>([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, fromBase64url(jwk.x ?? '')],
          [-3, fromBase64url(jwk.y ?? '')],
        ]),
      );
      const attested = concat(new Uint8Array(16), bigEndian(credentialId.length, 2), credentialId, coseKey);
      const attestationObject = encodeCBOR(
        new Map<string, CBORType>([
          ['fmt', 'none'],
          ['attStmt', new Map<string, CBORType>()],
          ['authData', authenticatorData(USER_PRESENT | USER_VERIFIED | ATTESTED_DATA, attested)],
        ]),
      );
      return {
        id,
        rawId: id,
        type: 'public-key',
        authenticatorAttachment: 'platform',
        clientExtensionResults: {},
        response: {
          clientDataJSON: base64url(clientData('webauthn.create', options)),
          attestationObject: base64url(attestationObject),
          transports: ['internal'],
        },
      };
    },
    /** Answers `navigator.credentials.get()` for the engine's authentication options. */
    async authenticate(options: unknown) {
      counter += 1;
      const data = authenticatorData(USER_PRESENT | USER_VERIFIED, new Uint8Array());
      const client = clientData('webauthn.get', options);
      const signed = concat(data, await sha256(client));
      const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, signed));
      return {
        id,
        rawId: id,
        type: 'public-key',
        authenticatorAttachment: 'platform',
        clientExtensionResults: {},
        response: {
          clientDataJSON: base64url(client),
          authenticatorData: base64url(data),
          signature: base64url(derSignature(raw)),
        },
      };
    },
  };
}
