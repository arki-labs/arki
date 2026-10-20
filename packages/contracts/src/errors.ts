import { defineFailure } from '@arki/failure';

/**
 * Static definition misuse raises {@link ContractsError} with a stable code.
 * Cursor and ID generation operations return canonical failures. Match on code. A `ContractsError` is a
 * `TypeError`, so `instanceof TypeError` checks written before the codes still hold.
 */

/** Stable error codes of `@arki/contracts`. */
export const CONTRACTS_ERROR_CODES = {
  /**
   * `defineId` got a prefix that is not letters, digits or `_`.
   *
   * @fix Use letters, digits and `_` only, for example `sty_`.
   * @verify bun run test -- src/ids.test.ts
   */
  invalidIdPrefix: 'ARKI_CONTRACTS_E001',
  /**
   * `assertUniqueIdPrefixes` found two prefixes that are equal or start one another.
   *
   * @fix Give each id kind a prefix that does not start another one.
   * @verify bun run test -- src/ids.test.ts
   */
  overlappingIdPrefixes: 'ARKI_CONTRACTS_E002',
  /**
   * Reserved legacy exception code; ID generation now returns RandomSourceUnavailable.
   *
   * @fix Run on an engine that has it. In React Native, install `react-native-get-random-values`.
   * @verify bun run test:runtimes
   */
  noRandomSource: 'ARKI_CONTRACTS_E003',
  /**
   * `keyset` got no keys.
   *
   * @fix Declare at least one key. Order by NOT NULL columns and end on a unique one.
   * @verify bun run test -- src/pagination.test.ts
   */
  invalidKeyset: 'ARKI_CONTRACTS_E004',
  /**
   * Reserved legacy exception code; cursor decoding now returns InvalidCursor.
   *
   * @fix Send back a cursor exactly as the same keyset returned it, or start from the first page.
   * @verify bun run test -- src/pagination.test.ts
   */
  invalidCursor: 'ARKI_CONTRACTS_E005',
  /**
   * A contract key contains `.` or uses a reserved name.
   *
   * @fix Rename the contract key: no `.`, and not a name the query utils reserve.
   * @verify bun run test -- src/orpc.test.ts
   */
  invalidContractKey: 'ARKI_CONTRACTS_E006',
  /**
   * `operationOf` got a value that carries no operation.
   *
   * @fix Pass a leaf of `createOrpcUtils`, or an object built by `operations()`.
   * @verify bun run test -- src/orpc.test.ts
   */
  notAnOperation: 'ARKI_CONTRACTS_E007',
  /**
   * The Drizzle column builder has no runtime config for its schema metadata.
   *
   * @fix Use a supported Drizzle column builder and matching Drizzle version.
   * @verify bun run test -- src/drizzle.test.ts
   */
  invalidColumnMetadata: 'ARKI_CONTRACTS_E008',
} as const;

/** The code of a {@link ContractsError}. */
export type ContractsErrorCode = (typeof CONTRACTS_ERROR_CODES)[keyof typeof CONTRACTS_ERROR_CODES];

const REMEDIATIONS: Record<ContractsErrorCode, string> = {
  ARKI_CONTRACTS_E001: 'Use letters, digits and "_" only, for example "sty_".',
  ARKI_CONTRACTS_E002: 'Give each id kind a prefix that is not the start of another one.',
  ARKI_CONTRACTS_E003:
    'Run on an engine with globalThis.crypto.getRandomValues. In React Native, install react-native-get-random-values.',
  ARKI_CONTRACTS_E004: 'Declare at least one key, and order by NOT NULL columns that end on a unique one.',
  ARKI_CONTRACTS_E005: 'Pass back a cursor exactly as the same keyset returned it, or start from the first page.',
  ARKI_CONTRACTS_E006: 'Rename the contract key: no ".", and not a name the query utils reserve.',
  ARKI_CONTRACTS_E008: 'Use a supported Drizzle column builder and matching Drizzle version.',
  ARKI_CONTRACTS_E007: 'Pass a leaf of createOrpcUtils, or an object built by operations().',
};

/** A coded failure of an `@arki/contracts` function. */
export class ContractsError extends TypeError {
  readonly code: ContractsErrorCode;
  /** What to do about it, in one sentence. */
  readonly remediation: string;

  constructor(code: ContractsErrorCode, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = 'ContractsError';
    this.code = code;
    this.remediation = REMEDIATIONS[code];
  }
}

/** A cursor cannot be decoded for this keyset.
 * @fix Send back the cursor unchanged, or start from the first page.
 * @verify bun run test -- src/pagination.test.ts
 */
export const InvalidCursor = defineFailure('contracts.invalid_cursor', {
  status: 400,
  message: 'The cursor is not valid for this list.',
  remediation: 'Send back the cursor unchanged, or start from the first page.',
});

/** A row has a missing or unrepresentable cursor key.
 * @fix Use non-null strings, finite numbers, booleans or valid Dates and keep the cursor within 1024 characters.
 * @verify bun run test -- src/pagination.test.ts
 */
export const InvalidCursorValue = defineFailure('contracts.invalid_cursor_value', {
  status: 500,
  message: 'The row cannot be represented by a cursor.',
  remediation: 'Use non-null strings, finite numbers, booleans or valid Dates and a cursor of at most 1024 characters.',
});

/** Secure ID generation has no usable Web Crypto provider.
 * @fix Provide globalThis.crypto.getRandomValues; install the React Native crypto polyfill when needed.
 * @verify bun run test -- src/ids.test.ts
 */
export const RandomSourceUnavailable = defineFailure('contracts.random_source_unavailable', {
  status: 500,
  message: 'Secure random generation is unavailable.',
  remediation: 'Provide globalThis.crypto.getRandomValues; install the React Native crypto polyfill when needed.',
});
