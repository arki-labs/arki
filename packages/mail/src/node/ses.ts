/**
 * Amazon SES (v2 API) through `@aws-sdk/client-sesv2`, an optional peer loaded on the first send.
 *
 * The SDK client is built with `maxAttempts: 1`: the SDK does not retry on its own. Retries belong
 * to the caller (the journal worker for queued mail), which knows how many tries are left.
 * SES has no idempotency token, so `idempotencyKey` is not forwarded. Tags go out as SES
 * `EmailTags`, whose names and values SES limits to ASCII letters, digits, `_` and `-`.
 *
 * SES needs SPF, DKIM and DMARC on the sending domain, and new accounts start in the sandbox
 * (200 mails a day, verified recipients only). Bounces and complaints arrive through SNS or a
 * configuration set, not in the response.
 */
import type { MailFailure, MailTransport } from '../types.js';
import { failed, MAIL_ERROR_CODES, ok } from '../errors.js';
import { errorField } from '../log.js';
import { listOf } from '../message.js';
import { fieldOf, stringOf } from '../narrow.js';
import { everyRecipient, logged, rejection, uncertain } from '../transport-failures.js';

export type SesOptions = {
  /** Default `'ses'`. */
  readonly id?: string;
  /** The SES region, e.g. `'eu-west-1'`. */
  readonly region: string;
  /** Omit to use the SDK's default chain (environment, shared config, instance role). */
  readonly credentials?: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly sessionToken?: string;
  };
  /** Configuration set for event publishing, reputation and IP pools. */
  readonly configurationSetName?: string;
  /** Monthly budget for `failover`. */
  readonly quotaPerMonth?: number;
};

// SES's documented charset name. SES expects this exact spelling, not Node's `utf8`.
// eslint-disable-next-line unicorn/text-encoding-identifier-case -- SES API value, not a Node encoding
const SES_CHARSET = 'UTF-8';

/** Memoizes the first call's promise; a rejected load is tried again on the next send. */
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= load().catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
}

/**
 * An SDK error with an HTTP status came from SES. Without one, the request never got an answer
 * (network failure, timeout, abort), and SES may have taken the mail.
 */
function sdkFailure(transport: string, error: unknown): MailFailure {
  const status = fieldOf(fieldOf(error, '$metadata'), 'httpStatusCode');
  if (typeof status !== 'number') return uncertain(transport, error);
  const providerCode = stringOf(fieldOf(error, 'name'));
  return rejection(transport, status, {
    message: errorField(error).message,
    ...(providerCode === undefined ? {} : { providerCode }),
  });
}

/**
 * @example
 * ses({ region: 'eu-west-1', quotaPerMonth: 200_000 })
 */
export function ses(options: SesOptions): MailTransport {
  const id = options.id ?? 'ses';
  const loadSdk = once(async () => {
    const { SESv2Client, SendEmailCommand } = await import('@aws-sdk/client-sesv2');
    const client = new SESv2Client({
      region: options.region,
      maxAttempts: 1,
      ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
    });
    return { client, SendEmailCommand };
  });

  return {
    id,
    ...(options.quotaPerMonth === undefined ? {} : { quotaPerMonth: options.quotaPerMonth }),
    async send(message, sendOptions) {
      let sdk: Awaited<ReturnType<typeof loadSdk>>;
      try {
        sdk = await loadSdk();
      } catch (error) {
        return logged(
          id,
          failed({
            code: MAIL_ERROR_CODES.invalidConfig,
            message: `${id}: @aws-sdk/client-sesv2 could not be loaded (${errorField(error).message})`,
            retryable: false,
            acceptance: 'none',
            transport: id,
          }),
        );
      }
      const replyTo = listOf(message.replyTo);
      const command = new sdk.SendEmailCommand({
        FromEmailAddress: message.from,
        Destination: {
          ToAddresses: [...listOf(message.to)],
          ...(message.cc === undefined ? {} : { CcAddresses: [...listOf(message.cc)] }),
          ...(message.bcc === undefined ? {} : { BccAddresses: [...listOf(message.bcc)] }),
        },
        ...(replyTo.length === 0 ? {} : { ReplyToAddresses: [...replyTo] }),
        ...(message.tags === undefined
          ? {}
          : { EmailTags: Object.entries(message.tags).map(([Name, Value]) => ({ Name, Value })) }),
        Content: {
          Simple: {
            Subject: { Data: message.subject, Charset: SES_CHARSET },
            Body: {
              Text: { Data: message.text, Charset: SES_CHARSET },
              ...(message.html === undefined ? {} : { Html: { Data: message.html, Charset: SES_CHARSET } }),
            },
            ...(message.headers === undefined
              ? {}
              : { Headers: Object.entries(message.headers).map(([Name, Value]) => ({ Name, Value })) }),
          },
        },
        ...(options.configurationSetName === undefined ? {} : { ConfigurationSetName: options.configurationSetName }),
      });
      try {
        const response = await sdk.client.send(
          command,
          sendOptions.signal === undefined ? {} : { abortSignal: sendOptions.signal },
        );
        return logged(
          id,
          ok({
            id: response.MessageId ?? null,
            transport: id,
            status: 'accepted',
            recipients: everyRecipient(message, 'accepted'),
          }),
        );
      } catch (error) {
        return logged(id, failed(sdkFailure(id, error)));
      }
    },
  };
}
