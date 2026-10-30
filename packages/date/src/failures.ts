/**
 * The expected failures of reading outside input: text that is not a date,
 * a native `Date` that cannot be a calendar date, a time-zone name the
 * runtime does not know. Match on `code` or with `Def.is`, never on the message.
 *
 * Failure data carries no more than the reason, the operation and a bounded
 * copy of the text, so it is safe to log and to send over the wire.
 */

import type { StandardSchemaV1 } from '@arki/schema';
import { defineFailure } from '@arki/failure';
import { is, recordSchema } from '@arki/schema';

/** The parsing operations that return {@link InvalidDateText}. Written once; the union below comes from it. */
export const DATE_TEXT_OPERATIONS = ['parseDate', 'parseDateTime', 'parseZoned', 'parseISO', 'parseDuration'] as const;

/** Why the text was refused. Written once; the union below comes from it. */
export const DATE_TEXT_REASONS = [
  'no_match',
  'trailing_text',
  'conflicting_tokens',
  'invalid_date',
  'invalid_time',
  'invalid_wall_time',
  'weekday_mismatch',
  'offset_out_of_range',
  'not_iso',
  'invalid_duration',
] as const;

/** Why a native `Date` is not a calendar date. */
export const NATIVE_DATE_REASONS = ['invalid_date'] as const;

export type DateTextOperation = (typeof DATE_TEXT_OPERATIONS)[number];
export type DateTextReason = (typeof DATE_TEXT_REASONS)[number];
export type NativeDateReason = (typeof NATIVE_DATE_REASONS)[number];

/** Longest copy of the bad input a failure keeps, in UTF-16 units. */
const MAX_INPUT_LENGTH = 64;

/** The first {@link MAX_INPUT_LENGTH} units of `text`, never ending in half a surrogate pair. */
export function boundedInput(text: string): Readonly<{ input: string; truncated: boolean }> {
  if (text.length <= MAX_INPUT_LENGTH) return { input: text, truncated: false };
  // A code point past U+FFFF at the last kept unit is a surrogate pair split by the cut: drop its first half too.
  const last = text.codePointAt(MAX_INPUT_LENGTH - 1) ?? 0;
  const cut = last > 65_535 ? MAX_INPUT_LENGTH - 1 : MAX_INPUT_LENGTH;
  return { input: text.slice(0, cut), truncated: true };
}

type ReadObject = Readonly<Record<string, unknown>>;

function readObject(value: unknown): ReadObject | undefined {
  return is(value, recordSchema) ? value : undefined;
}

function pick<Choice extends string>(choices: readonly Choice[], value: unknown): Choice | undefined {
  return choices.find(choice => choice === value);
}

// The package keeps zod an optional peer, so these data schemas are hand-written Standard Schemas.
/** The data of {@link InvalidDateText}. */
export type InvalidDateTextData = Readonly<{
  operation: DateTextOperation;
  reason: DateTextReason;
  input: string;
  truncated: boolean;
}>;

/** The data of {@link InvalidNativeDate}. */
export type InvalidNativeDateData = Readonly<{ reason: NativeDateReason }>;

/** The data of {@link UnknownTimeZone}. */
export type UnknownTimeZoneData = Readonly<{ timeZone: string; truncated: boolean }>;

/** A Standard Schema over `validate`; the annotation gives `defineFailure` the typed data. */
function dataSchema<Data>(validate: (value: unknown) => StandardSchemaV1.Result<Data>): StandardSchemaV1<Data> {
  return { '~standard': { version: 1, vendor: 'arki-date', validate } };
}

function validateText(value: unknown): StandardSchemaV1.Result<InvalidDateTextData> {
  const data = readObject(value);
  const operation = pick(DATE_TEXT_OPERATIONS, data?.operation);
  const reason = pick(DATE_TEXT_REASONS, data?.reason);
  if (
    data !== undefined &&
    operation !== undefined &&
    reason !== undefined &&
    typeof data.input === 'string' &&
    data.input.length <= MAX_INPUT_LENGTH &&
    typeof data.truncated === 'boolean'
  ) {
    return { value: { operation, reason, input: data.input, truncated: data.truncated } };
  }
  return { issues: [{ message: 'Expected an operation, a reason, a bounded input and a truncated flag.' }] };
}

function validateNative(value: unknown): StandardSchemaV1.Result<InvalidNativeDateData> {
  const reason = pick(NATIVE_DATE_REASONS, readObject(value)?.reason);
  if (reason !== undefined) return { value: { reason } };
  return { issues: [{ message: 'Expected a reason.' }] };
}

function validateZone(value: unknown): StandardSchemaV1.Result<UnknownTimeZoneData> {
  const data = readObject(value);
  if (
    data !== undefined &&
    typeof data.timeZone === 'string' &&
    data.timeZone.length <= MAX_INPUT_LENGTH &&
    typeof data.truncated === 'boolean'
  ) {
    return { value: { timeZone: data.timeZone, truncated: data.truncated } };
  }
  return { issues: [{ message: 'Expected a bounded time zone and a truncated flag.' }] };
}

/** Text the pattern or ISO reader refused. `data.reason` says why; `data.input` is a bounded copy of the text.
 * @fix Show the user the reason and ask for the text again, or read it with another pattern. A bad pattern is a bug and throws instead.
 * @verify bun run test -- src/parse.test.ts src/iso.test.ts
 */
export const InvalidDateText = defineFailure('date.invalid_text', {
  status: 400,
  data: dataSchema(validateText),
  message: ({ operation, reason }) => `${operation} refused the text: ${reason}.`,
  remediation: 'Ask for the text again, or read it with another pattern. Match on data.reason.',
});

/** A {@link InvalidDateText} failure value. */
export type InvalidDateText = ReturnType<typeof InvalidDateText>;

/** A native `Date` that holds no calendar date: an Invalid Date (`new Date('nope')`). Every valid `Date` fits a Temporal date.
 * @fix Check the picker or API that built the `Date`. Reject the value or ask for another.
 * @verify bun run test -- src/interop.test.ts
 */
export const InvalidNativeDate = defineFailure('date.invalid_native_date', {
  status: 400,
  data: dataSchema(validateNative),
  message: ({ reason }) => `The Date is not a calendar date: ${reason}.`,
  remediation: 'Reject the value or ask for another date. Match on data.reason.',
});

/** A {@link InvalidNativeDate} failure value. */
export type InvalidNativeDate = ReturnType<typeof InvalidNativeDate>;

/** A time-zone name the runtime does not know. `data.timeZone` is a bounded copy of the name.
 * @fix Ask for an IANA name such as `Europe/Bucharest` or a fixed offset such as `+02:00`. Check a name first with `isValidTimeZone`.
 * @verify bun run test -- src/parse.test.ts src/interop.test.ts
 */
export const UnknownTimeZone = defineFailure('date.unknown_time_zone', {
  status: 400,
  data: dataSchema(validateZone),
  message: 'The time zone is not known to this runtime.',
  remediation: 'Use an IANA name such as Europe/Bucharest or a fixed offset such as +02:00.',
});

/** A {@link UnknownTimeZone} failure value. */
export type UnknownTimeZone = ReturnType<typeof UnknownTimeZone>;

/** Builds the failure for unknown zone text. */
export function unknownTimeZone(timeZone: string): UnknownTimeZone {
  const { input, truncated } = boundedInput(timeZone);
  return UnknownTimeZone({ timeZone: input, truncated });
}
