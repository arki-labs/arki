/**
 * Templates are plain objects. One Standard Schema types both sides: callers pass its input,
 * renderers receive its output (defaults applied, values coerced).
 */
import type { FailureOf } from '@arki/failure';
import type { SchemaInput, SchemaOutput, StandardSchemaV1 } from '@arki/schema';
import { parseAsync, pathOf, SchemaError } from '@arki/schema';

import type { Address, Addresses, Awaitable, MailContent, RenderContext } from './types.js';
import { MailInvalidInput } from './failures.js';

/** A path key as JSON can hold it: a symbol key becomes its description. */
const plainKey = (key: PropertyKey): string | number => (typeof key === 'symbol' ? String(key) : key);

export type MailTemplate<S extends StandardSchemaV1 = StandardSchemaV1, Name extends string = string> = {
  /** Stable name, for logs, the test sink and queued mail. */
  readonly name: Name;
  readonly input: S;
  readonly subject: (data: SchemaOutput<S>, context: RenderContext) => string;
  readonly text: (data: SchemaOutput<S>, context: RenderContext) => Awaitable<string>;
  readonly html?: (data: SchemaOutput<S>, context: RenderContext) => Awaitable<string>;
  readonly defaults?: {
    readonly from?: Address;
    readonly replyTo?: Addresses;
    readonly headers?: Readonly<Record<string, string>>;
    readonly tags?: Readonly<Record<string, string>>;
  };
};

/**
 * Defines a template. Returns it unchanged; the point is the inferred types.
 *
 * @example
 * const welcome = defineTemplate({
 *   name: 'welcome',
 *   input: z.object({ name: z.string() }),
 *   subject: data => `Welcome, ${data.name}`,
 *   text: data => `Hello ${data.name}, your account is ready.`,
 * });
 */
export function defineTemplate<S extends StandardSchemaV1, const Name extends string>(
  template: MailTemplate<S, Name>,
): MailTemplate<S, Name> {
  return template;
}

/**
 * Validates `input` with the template's schema (sync or async) and renders the content.
 * Needs no transport: use it for previews and content tests. Bad input is `MailInvalidInput`
 * with the schema's issues.
 */
export async function renderTemplate<S extends StandardSchemaV1>(
  template: MailTemplate<S>,
  input: NoInfer<SchemaInput<S>>,
  context: RenderContext = {},
): Promise<MailContent | FailureOf<typeof MailInvalidInput>> {
  let data: SchemaOutput<S>;
  try {
    data = await parseAsync(template.input, input);
  } catch (error) {
    // Bad data is a result. A schema that cannot run (`SchemaRunError`) is a bug and is rethrown.
    if (!(error instanceof SchemaError)) throw error;
    return MailInvalidInput({
      template: template.name,
      issues: error.issues.map(issue => ({ path: pathOf(issue).map(key => plainKey(key)), message: issue.message })),
    });
  }
  const [text, html] = await Promise.all([template.text(data, context), template.html?.(data, context)]);
  return {
    subject: template.subject(data, context),
    text,
    ...(html === undefined ? {} : { html }),
    ...(template.defaults?.headers === undefined ? {} : { headers: template.defaults.headers }),
    ...(template.defaults?.tags === undefined ? {} : { tags: template.defaults.tags }),
  };
}
