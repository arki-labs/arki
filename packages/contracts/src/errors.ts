/**
 * Every failure this package raises on purpose is a {@link ContractsError} with a
 * stable `code`. Match on the code, never on the message. A `ContractsError` is a
 * `TypeError`, so `instanceof TypeError` checks written before the codes still hold.
 */

/** Stable error codes of `@arki/contracts`. */
export const CONTRACTS_ERROR_CODES = {
  /** `defineId` got a prefix that is not letters, digits or `_`. */
  invalidIdPrefix: 'ARKI_CONTRACTS_E001',
  /** `assertUniqueIdPrefixes` found two prefixes that are equal or start one another. */
  overlappingIdPrefixes: 'ARKI_CONTRACTS_E002',
  /** `create()` found no `globalThis.crypto.getRandomValues`. */
  noRandomSource: 'ARKI_CONTRACTS_E003',
  /** `keyset` got no keys, or a row with a NULL key value. */
  invalidKeyset: 'ARKI_CONTRACTS_E004',
  /** A cursor string is not one the keyset made. */
  invalidCursor: 'ARKI_CONTRACTS_E005',
  /** A contract key contains "." or uses a reserved name. */
  invalidContractKey: 'ARKI_CONTRACTS_E006',
  /** `operationOf` got a value that carries no operation. */
  notAnOperation: 'ARKI_CONTRACTS_E007',
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
