import type { SchemaInput, SchemaOutput, StandardSchemaV1 } from '@arki/schema';
import type { ReactElement } from 'react';
import { parseAsync, SchemaError } from '@arki/schema';

import type { EmailProvider, SendEmailPayload, SendEmailResult } from '../providers/types';

// ── Internal config ──────────────────────────────────────────

type Resolver<TInput, TOut> = TOut | ((input: TInput) => TOut);

/** `TOutput` is what the resolvers receive: the schema's output, or `void` when there is no schema. */
type EmailProcedureConfig<TOutput> = {
  /** Turns the call-site `input` into `TOutput`. Rejects with `SchemaError` when it does not match. */
  parseInput: (raw: unknown) => Promise<TOutput>;
  from?: Resolver<TOutput, string>;
  subject?: Resolver<TOutput, string>;
  text?: Resolver<TOutput, string>;
  html?: Resolver<TOutput, string>;
  react?: Resolver<TOutput, ReactElement>;
};

function resolve<TInput, TOut>(fn: Resolver<TInput, TOut> | undefined, input: TInput, fallback: TOut): TOut {
  if (fn === undefined) return fallback;
  if (typeof fn === 'function') return (fn as (i: TInput) => TOut)(input);
  return fn;
}

// ── Send options — typed on whether an input schema was provided ──

type SendOptions<TInput> = [TInput] extends [never]
  ? {
      to: string | string[];
      from?: string;
      subject?: string;
      cc?: string | string[];
      bcc?: string | string[];
    }
  : {
      to: string | string[];
      input: TInput;
      from?: string;
      subject?: string;
      cc?: string | string[];
      bcc?: string | string[];
    };

// ── EmailProcedure — the builder ─────────────────────────────

/**
 * A typed, chainable email definition.
 *
 * Inspired by tRPC's procedure builder: each chained method returns a *new*
 * immutable instance so definitions can be composed without mutation.
 *
 * ```ts
 * const magicLink = emails.email
 *   .input(z.object({ url: z.url() }))
 *   .from('Acme <no-reply@example.com>')
 *   .subject('Your magic link')
 *   .react(({ url }) => <MagicLinkEmail url={url} />);
 *
 * await magicLink.send({ to: user.email, input: { url } });
 * ```
 */
export class EmailProcedure<TInput = never, TOutput = void> {
  constructor(
    protected readonly _provider: EmailProvider,
    private readonly _config: EmailProcedureConfig<TOutput>,
  ) {}

  // ── Builder methods ──────────────────────────────────────

  /**
   * Set the sender address. Accepts a static string or a function that
   * receives the validated input and returns a string.
   */
  from(value: Resolver<TOutput, string>): EmailProcedure<TInput, TOutput> {
    return new EmailProcedure(this._provider, { ...this._config, from: value });
  }

  /**
   * Set the email subject. Accepts a static string or a resolver function.
   */
  subject(value: Resolver<TOutput, string>): EmailProcedure<TInput, TOutput> {
    return new EmailProcedure(this._provider, { ...this._config, subject: value });
  }

  /**
   * Set the plain-text body. Accepts a static string or a resolver function.
   */
  text(value: Resolver<TOutput, string>): EmailProcedure<TInput, TOutput> {
    return new EmailProcedure(this._provider, { ...this._config, text: value });
  }

  /**
   * Set the HTML body. Accepts a static string or a resolver function.
   */
  html(value: Resolver<TOutput, string>): EmailProcedure<TInput, TOutput> {
    return new EmailProcedure(this._provider, { ...this._config, html: value });
  }

  /**
   * Set the React Email component as the email body.
   *
   * The component is rendered to HTML via `@react-email/render` at send time,
   * making it compatible with all providers (not just Resend).
   *
   * @example
   * ```tsx
   * const invite = emails.email
   *   .input(z.object({ name: z.string(), url: z.string() }))
   *   .react(({ name, url }) => <InviteEmail name={name} url={url} />);
   * ```
   */
  react(value: Resolver<TOutput, ReactElement>): EmailProcedure<TInput, TOutput> {
    return new EmailProcedure(this._provider, { ...this._config, react: value });
  }

  // ── Execution ────────────────────────────────────────────

  /**
   * Send the email.
   *
   * - `to`: recipient(s).
   * - `input`: validated against the schema defined via `.input(schema)`;
   *   the resolvers get the schema's output. Omit if no schema was attached.
   *   Invalid input returns `{ data: null, error: { name: 'ValidationError' } }`.
   * - `from` / `subject`: optional overrides — useful for per-call
   *   personalisation on top of a shared definition.
   */
  async send(options: SendOptions<TInput>): Promise<SendEmailResult> {
    let callInput: TOutput;
    try {
      callInput = await this._config.parseInput('input' in options ? options.input : undefined);
    } catch (error) {
      // Bad input is a result, like every other send failure. A schema that cannot run is a bug: let it throw.
      if (!(error instanceof SchemaError)) throw error;
      return { data: null, error: { message: error.message, name: 'ValidationError', issues: error.issues } };
    }

    const from = (options as { from?: string }).from ?? resolve(this._config.from, callInput, '');
    const subject = (options as { subject?: string }).subject ?? resolve(this._config.subject, callInput, '');

    let html: string | undefined = resolve(this._config.html, callInput, undefined as unknown as string) || undefined;

    // Render React Email component to HTML if provided and no static HTML set.
    const reactEl = resolve(this._config.react, callInput, undefined as unknown as ReactElement);
    if (reactEl && !html) {
      const { render } = await import('@react-email/render');
      html = await render(reactEl);
    }

    const payload: SendEmailPayload = {
      to: options.to,
      from,
      subject,
      text: resolve(this._config.text, callInput, undefined as unknown as string) || undefined,
      html,
      cc: options.cc,
      bcc: options.bcc,
    };

    return this._provider.send(payload);
  }
}

/**
 * The start of an email definition (`emails.email`). Only it has `.input()`,
 * and every setter returns a plain {@link EmailProcedure}, so `.input()` can
 * only come first: resolvers set before it would be typed for no input.
 */
export class EmailBuilder extends EmailProcedure {
  constructor(provider: EmailProvider) {
    super(provider, { parseInput: () => Promise.resolve() });
  }

  /**
   * Attach a schema that validates and types the call-site `input`. Any
   * Standard Schema works (Zod, Valibot, ArkType, ...), sync or async.
   * `send` takes the schema's input type; the resolvers get its output.
   * This is the equivalent of `t.procedure.input(schema)` in tRPC.
   */
  input<S extends StandardSchemaV1>(schema: S): EmailProcedure<SchemaInput<S>, SchemaOutput<S>> {
    return new EmailProcedure(this._provider, { parseInput: raw => parseAsync<SchemaOutput<S>>(schema, raw) });
  }
}
