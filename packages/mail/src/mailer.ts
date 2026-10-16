/**
 * The mailer: renders a template, checks the message, hands it to one transport, and reports
 * what happened. It never throws for a failed send; it returns `{ data, error }`.
 */
import type { SchemaInput, StandardSchemaV1 } from '@arki/schema';

import type { MailTemplate } from './template.js';
import type {
  Address,
  Addresses,
  Awaitable,
  MailContent,
  MailEvent,
  MailFailure,
  MailMessage,
  MailResult,
  MailTransport,
  RenderContext,
  SendOptions,
} from './types.js';
import { failed, invalidConfig, MAIL_ERROR_CODES, ok } from './errors.js';
import { failover } from './failover.js';
import { errorField, log } from './log.js';
import { checkMessage, listOf, redirect } from './message.js';
import { renderTemplate } from './template.js';

export type MailerOptions = {
  readonly transport: MailTransport;
  /** The sender when neither the send nor the template names one. */
  readonly from: Address;
  /** Staging guard: every mail goes here instead; Cc and Bcc are dropped. */
  readonly redirectTo?: Addresses;
  /** Observe each send. Errors thrown here are logged and never change the result. */
  readonly onEvent?: (event: MailEvent) => Awaitable<void>;
};

/** A message for `sendRaw`: the sender may come from the mailer. */
export type RawMail = Omit<MailMessage, 'from'> & { readonly from?: Address };

export type Mailer = {
  /** Validates `input` with the template's schema, renders, and sends. */
  send<S extends StandardSchemaV1>(
    template: MailTemplate<S>,
    input: NoInfer<SchemaInput<S>>,
    options: SendOptions,
  ): Promise<MailResult>;
  /** Sends content you rendered yourself. */
  sendRaw(message: RawMail, options?: Pick<SendOptions, 'idempotencyKey' | 'signal'>): Promise<MailResult>;
  /**
   * Renders, addresses and checks a mail without sending it: the sender is resolved and the
   * message validated. `@arki/mail/pg` stores the result to send later.
   */
  compose<S extends StandardSchemaV1>(
    template: MailTemplate<S>,
    input: NoInfer<SchemaInput<S>>,
    options: Omit<SendOptions, 'signal' | 'idempotencyKey'>,
  ): Promise<MailResult<MailMessage>>;
  /** Renders without sending: previews and content tests. */
  render<S extends StandardSchemaV1>(
    template: MailTemplate<S>,
    input: NoInfer<SchemaInput<S>>,
    context?: RenderContext,
  ): Promise<MailResult<MailContent>>;
};

/**
 * @example
 * const mail = mailer({ transport: resend({ apiKey }), from: 'App <hi@app.dev>' });
 * const { error } = await mail.send(welcome, { name: 'Ada' }, { to: 'ada@example.com' });
 */
export function mailer(options: MailerOptions): Mailer {
  const { from: defaultFrom, redirectTo, onEvent } = options;
  // A lone transport's quota is still a budget; `failover` is what counts it.
  const transport = options.transport.quotaPerMonth === undefined ? options.transport : failover([options.transport]);
  if (defaultFrom.trim() === '') invalidConfig('`from` is empty.');
  if (redirectTo !== undefined && listOf(redirectTo).length === 0) invalidConfig('`redirectTo` lists no address.');

  const emit = async (event: MailEvent): Promise<void> => {
    if (onEvent === undefined) return;
    try {
      await onEvent(event);
    } catch (error) {
      log.warn('onEvent threw on a {type} event; the send result is unchanged', {
        type: event.type,
        error: errorField(error),
      });
    }
  };

  const fail = async (failure: MailFailure, template: string | undefined): Promise<MailResult> => {
    await emit({ type: 'failed', failure, template });
    return failed(failure);
  };

  const deliver = async (
    message: MailMessage,
    sendOptions: Pick<SendOptions, 'idempotencyKey' | 'signal'>,
  ): Promise<MailResult> => {
    const problem = checkMessage(message);
    if (problem !== undefined) return fail(problem, message.template);
    const outgoing = redirectTo === undefined ? message : redirect(message, redirectTo);
    await emit({ type: 'sending', transport: transport.id, template: message.template });
    let result: MailResult;
    try {
      result = await transport.send(outgoing, sendOptions);
    } catch (error) {
      // A transport must not throw. If one does, the request may have gone out: treat it as uncertain.
      return fail(
        {
          code: MAIL_ERROR_CODES.uncertain,
          message: `Transport "${transport.id}" threw: ${error instanceof Error ? error.message : String(error)}`,
          retryable: true,
          acceptance: 'unknown',
          transport: transport.id,
        },
        message.template,
      );
    }
    if (result.error !== null) return fail(result.error, message.template);
    await emit({ type: 'sent', result: result.data, template: message.template });
    return result;
  };

  const compose: Mailer['compose'] = async (template, input, sendOptions) => {
    const rendered = await renderTemplate(template, input, { locale: sendOptions.locale });
    if (rendered.error !== null) return rendered;
    const message: MailMessage = {
      ...rendered.data,
      from: sendOptions.from ?? template.defaults?.from ?? defaultFrom,
      to: sendOptions.to,
      cc: sendOptions.cc,
      bcc: sendOptions.bcc,
      replyTo: sendOptions.replyTo ?? template.defaults?.replyTo,
      template: template.name,
    };
    const problem = checkMessage(message);
    return problem === undefined ? ok(message) : failed(problem);
  };

  return {
    async send(template, input, sendOptions) {
      const composed = await compose(template, input, sendOptions);
      if (composed.error !== null) return fail(composed.error, template.name);
      return deliver(composed.data, { idempotencyKey: sendOptions.idempotencyKey, signal: sendOptions.signal });
    },
    compose,
    sendRaw: (message, sendOptions = {}) => deliver({ ...message, from: message.from ?? defaultFrom }, sendOptions),
    render: (template, input, context) => renderTemplate(template, input, context),
  };
}
