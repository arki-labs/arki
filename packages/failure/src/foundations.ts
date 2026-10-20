/** Canonical failures shared by validation, revival and operation boundaries. */
import type { StandardSchemaV1 } from '@standard-schema/spec';

import { defineFailure } from './failure.js';

/** Small bootstrap schemas do not depend on the executor that uses these failures. */
function bootstrapSchema<Output>(
  validate: (value: unknown) => StandardSchemaV1.Result<Output>,
): StandardSchemaV1<unknown, Output> {
  return { '~standard': { version: 1, vendor: 'arki-failure', validate } };
}

/** @internal Copy only Standard Schema issue fields; never publish validator-specific input or metadata. */
export function readIssues(value: unknown): readonly StandardSchemaV1.Issue[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const issues: StandardSchemaV1.Issue[] = [];
  const entries: readonly unknown[] = value;
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null || !('message' in entry)) return undefined;
    const message = entry.message;
    if (typeof message !== 'string') return undefined;
    if (!('path' in entry) || entry.path === undefined) {
      issues.push({ message });
      continue;
    }
    const rawPath: unknown = entry.path;
    if (!Array.isArray(rawPath)) return undefined;
    const path: PropertyKey[] = [];
    const segments: readonly unknown[] = rawPath;
    for (const segment of segments) {
      const key = typeof segment === 'object' && segment !== null && 'key' in segment ? segment.key : segment;
      if (typeof key === 'string') path.push(key);
      else if (typeof key === 'number' && Number.isFinite(key)) path.push(key);
      else if (typeof key === 'symbol') path.push(String(key));
      else return undefined;
    }
    issues.push({ message, path });
  }
  return issues;
}

type InputData = { issues: readonly StandardSchemaV1.Issue[] };

const inputData = bootstrapSchema<InputData>((value: unknown) => {
  if (typeof value === 'object' && value !== null && 'issues' in value) {
    const issues = readIssues(value.issues);
    if (issues !== undefined) return { value: { issues } };
  }
  return { issues: [{ message: 'Expected validation issues.' }] };
});

/** Input failed the schema's checks. Only intentional public issue fields are retained.
 * @fix Correct the reported input issues.
 * @verify bun run test -- src/schema.test.ts
 */
export const InvalidInput = defineFailure('schema.invalid_input', {
  status: 400,
  data: inputData,
  message: 'Input does not match the schema.',
  remediation: 'Correct the reported input issues.',
});

/** A synchronous operation received an asynchronous validator result.
 * @fix Use parseAsync() and await the result.
 * @verify bun run test -- src/schema.test.ts
 */
export const AsyncSchema = defineFailure('schema.async_required', {
  status: 500,
  message: 'The schema requires asynchronous validation.',
  remediation: 'Use parseAsync() and await the result.',
});

/** A validator threw, rejected, or violated the Standard Schema result contract.
 * @fix Fix the validator; inspect the private cause for details.
 * @verify bun run test -- src/schema.test.ts
 */
export const ValidatorDefect = defineFailure('schema.validator_defect', {
  status: 500,
  message: 'The schema could not validate the input.',
  remediation: 'Fix the validator; inspect the private cause for details.',
});

/** Stable reasons a failure envelope cannot be accepted. */
export const INVALID_ENVELOPE_REASONS = [
  'malformed',
  'unknown_code',
  'unsupported_version',
  'invalid_data',
  'non_json_data',
  'unstable_schema',
  'invalid_json',
] as const;

function isEnvelopeReason(value: unknown): value is (typeof INVALID_ENVELOPE_REASONS)[number] {
  for (const reason of INVALID_ENVELOPE_REASONS) {
    if (reason === value) return true;
  }
  return false;
}

type EnvelopeData = { reason: (typeof INVALID_ENVELOPE_REASONS)[number] };

const envelopeData = bootstrapSchema<EnvelopeData>((value: unknown) => {
  if (typeof value === 'object' && value !== null && 'reason' in value) {
    const reason = value.reason;
    if (isEnvelopeReason(reason)) return { value: { reason } };
  }
  return { issues: [{ message: 'Expected a failure envelope reason.' }] };
});

/** An external envelope cannot be trusted as a known failure.
 * @fix Send a supported failure envelope with validated JSON data.
 * @verify bun run test -- src/revive.test.ts
 */
export const InvalidEnvelope = defineFailure('failure.invalid_envelope', {
  status: 400,
  data: envelopeData,
  message: 'The failure envelope is invalid.',
  remediation: 'Send a supported failure envelope with validated JSON data.',
});

/** A caught operation defect, distinct from the UnexpectedFailure exception bridge.
 * @fix Inspect the private cause and fix the operation.
 * @verify bun run test -- src/schema.test.ts
 */
export const UnexpectedDefect = defineFailure('failure.unexpected_defect', {
  status: 500,
  message: 'The operation could not complete.',
  remediation: 'Inspect the private cause and fix the operation.',
});
