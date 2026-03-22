import { z } from 'zod';

import type { EmailProvider, SendEmailPayload, SendEmailResult } from '../providers/types';

// ── Internal config ──────────────────────────────────────────

type Resolver<TInput, TOut> = TOut | ((input: TInput) => TOut);

type EmailProcedureConfig<TInput> = {
  schema?: z.ZodType<TInput>;
  from?: Resolver<TInput, string>;
  subject?: Resolver<TInput, string>;
  text?: Resolver<TInput, string>;
  html?: Resolver<TInput, string>;
};

function resolve<TInput, TOut>(
  fn: Resolver<TInput, TOut> | undefined,
  input: TInput,
  fallback: TOut,
): TOut {
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
 *   .input(z.object({ url: z.string().url() }))
 *   .from('Avocabo <no-reply@avocabo.app>')
 *   .subject('Your magic link')
 *   .text(({ url }) => `Sign in: ${url}`);
 *
 * await magicLink.send({ to: user.email, input: { url } });
 * ```
 */
export class EmailProcedure<TInput = never> {
  constructor(
    private readonly _provider: EmailProvider,
    private readonly _config: EmailProcedureConfig<TInput> = {},
  ) {}

  // ── Builder methods ──────────────────────────────────────

  /**
   * Attach a Zod schema that validates and types the call-site `input`.
   * This is the equivalent of `t.procedure.input(schema)` in tRPC.
   */
  input<S extends z.ZodTypeAny>(schema: S): EmailProcedure<z.infer<S>> {
    return new EmailProcedure<z.infer<S>>(this._provider, {
      ...(this._config as EmailProcedureConfig<z.infer<S>>),
      schema: schema as unknown as z.ZodType<z.infer<S>>,
    });
  }

  /**
   * Set the sender address. Accepts a static string or a function that
   * receives the validated input and returns a string.
   */
  from(value: Resolver<TInput, string>): EmailProcedure<TInput> {
    return new EmailProcedure(this._provider, { ...this._config, from: value });
  }

  /**
   * Set the email subject. Accepts a static string or a resolver function.
   */
  subject(value: Resolver<TInput, string>): EmailProcedure<TInput> {
    return new EmailProcedure(this._provider, { ...this._config, subject: value });
  }

  /**
   * Set the plain-text body. Accepts a static string or a resolver function.
   */
  text(value: Resolver<TInput, string>): EmailProcedure<TInput> {
    return new EmailProcedure(this._provider, { ...this._config, text: value });
  }

  /**
   * Set the HTML body. Accepts a static string or a resolver function.
   */
  html(value: Resolver<TInput, string>): EmailProcedure<TInput> {
    return new EmailProcedure(this._provider, { ...this._config, html: value });
  }

  // ── Execution ────────────────────────────────────────────

  /**
   * Send the email.
   *
   * - `to`: recipient(s).
   * - `input`: validated against the schema defined via `.input(schema)`.
   *   Omit if no schema was attached.
   * - `from` / `subject`: optional overrides — useful for per-call
   *   personalisation on top of a shared definition.
   */
  async send(options: SendOptions<TInput>): Promise<SendEmailResult> {
    const callInput = (options as { input?: TInput }).input as TInput;

    if (this._config.schema) {
      this._config.schema.parse(callInput);
    }

    const from = (options as { from?: string }).from ?? resolve(this._config.from, callInput, '');
    const subject =
      (options as { subject?: string }).subject ?? resolve(this._config.subject, callInput, '');

    const payload: SendEmailPayload = {
      to: options.to,
      from,
      subject,
      text: resolve(this._config.text, callInput, undefined as unknown as string) || undefined,
      html: resolve(this._config.html, callInput, undefined as unknown as string) || undefined,
      cc: options.cc,
      bcc: options.bcc,
    };

    return this._provider.send(payload);
  }
}
