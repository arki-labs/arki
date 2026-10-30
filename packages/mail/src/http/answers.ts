/**
 * What each service's answer looks like, as schemas. An answer is outside data: a field of the
 * wrong type is read as absent, never as a crash, and the whole answer not being an object reads
 * as "nothing usable". One schema per service answer, so the shape is written once.
 */
import { z } from 'zod';

/** Reads a field with `schema`; a value that does not fit reads as absent, never as a crash. */
function lenient<Schema extends z.ZodType>(schema: Schema) {
  return z
    .unknown()
    .transform((value): z.output<Schema> | undefined => {
      const parsed = schema.safeParse(value);
      return parsed.success ? parsed.data : undefined;
    })
    .optional();
}

/** A string field; anything else reads as absent. */
const text = lenient(z.string());
/** An error code the service sends as a string or a number. */
const code = lenient(z.union([z.string(), z.number()]));
/** A list of strings; a list with anything else in it reads as absent. */
const strings = lenient(z.array(z.string()));

export const resendRefusalSchema = z.object({ message: text, name: text });
export const resendSentSchema = z.object({ id: text });

export const mailpitRefusalSchema = z.object({ Error: text });
export const mailpitSentSchema = z.object({ ID: text });

const cloudflareError = z.object({ message: text, code });
/** Cloudflare's envelope: `success`, the `errors` list, and the `result` of a send. */
export const cloudflareAnswerSchema = z.object({
  success: lenient(z.boolean()),
  errors: lenient(z.array(cloudflareError)),
  result: lenient(
    z.object({
      message_id: text,
      delivered: strings,
      queued: strings,
      permanent_bounces: strings,
      suppressed_recipients: strings,
    }),
  ),
});

/** Unosend sends the error top level (`{ message, code }`) or nested (`{ error: { message, code } }` or `{ error: "text" }`). */
export const unosendRefusalSchema = z.object({
  message: text,
  code,
  error: lenient(z.union([z.string(), z.object({ message: text, code })])),
});
export const unosendSentSchema = z.object({
  id: text,
  data: lenient(z.object({ id: text })),
});

/** The parts of an AWS SDK error the SES transport reads. */
export const sesErrorSchema = z.object({
  name: text,
  $metadata: lenient(z.object({ httpStatusCode: lenient(z.number()) })),
});

/** The raw HTTP response an AWS SDK service error keeps, for its headers. */
export const sesResponseHeadersSchema = z.object({
  $response: lenient(z.object({ headers: lenient(z.record(z.string(), z.string())) })),
});

/**
 * `body` read with `schema`, or `undefined` when it is not an object the schema accepts (no
 * body, a string, a list). The fields the schema reads never throw.
 */
export function readAnswer<Schema extends z.ZodType>(schema: Schema, body: unknown): z.output<Schema> | undefined {
  const parsed = schema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

/** A code from a service as text: `4001` and `"4001"` both read `"4001"`. */
export function codeText(value: string | number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}
