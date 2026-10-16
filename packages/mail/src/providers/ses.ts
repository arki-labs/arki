import type { EmailProvider, SendEmailPayload, SendEmailResult } from './types';
import { debugEmails } from '../debug';

/** Memoize the first call's promise; a rejected load is retried on the next send. */
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= load().catch((err: unknown) => {
      pending = undefined;
      throw err;
    });
    return pending;
  };
}

function toAddresses(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

/**
 * Creates an email provider backed by Amazon SES (v2 API).
 *
 * SES is the cheapest managed outbound option at scale (~$0.10/1k emails) but
 * requires AWS credentials (env vars `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
 * and a region). Pass `region` and `credentials` explicitly if you don't want
 * to rely on the SDK's default credential chain.
 *
 * SES requires SPF / DKIM / DMARC alignment on the sending domain — set this up
 * before sending any production traffic. New sending identities start in the
 * sandbox (200/day, verified recipients only) until you request production access.
 *
 * **Caveats specific to SES:**
 * - The sandbox limit is 200 emails / 24h until production access is granted.
 *   Plan for at least one business day of review.
 * - Bounce and complaint events arrive via SNS/SES Configuration Sets, not in
 *   the response — wire those up separately if you need automatic suppression.
 * - Hard rejection at send-time surfaces here as an error result; the SDK does
 *   not throw for `MessageRejected` or `MailFromDomainNotVerifiedException`.
 *
 * @example
 * ```ts
 * sesProvider({ region: 'eu-west-1', quotaPerMonth: 200_000 })
 * ```
 */
export function sesProvider(options: {
  /** AWS region for the SES endpoint (e.g. `'eu-west-1'`, `'us-east-1'`). */
  region: string;
  /**
   * Optional explicit credentials. Omit to use the SDK's default chain
   * (env vars, shared config, IMDS, etc.).
   */
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  /**
   * Optional Configuration Set name — applies sender reputation, event
   * publishing, and IP pool routing per SES configuration.
   */
  configurationSetName?: string;
  /**
   * Monthly send quota for this SES sending account.
   * SES quotas are per-region per-account and depend on production-access
   * tier. Used by the quota router to select providers.
   */
  quotaPerMonth?: number;
}): EmailProvider {
  // Lazy: `@aws-sdk/client-sesv2` is an optional peer dependency, loaded on the first send.
  const loadSdk = once(async () => {
    const { SESv2Client, SendEmailCommand } = await import('@aws-sdk/client-sesv2');
    return {
      SendEmailCommand,
      client: new SESv2Client({
        region: options.region,
        ...(options.credentials ? { credentials: options.credentials } : {}),
      }),
    };
  });

  return {
    name: 'ses',
    quotaPerMonth: options.quotaPerMonth,

    async send(payload: SendEmailPayload): Promise<SendEmailResult> {
      debugEmails.debug('[ses] Sending to={to} subject="{subject}"', { to: payload.to, subject: payload.subject });

      const toAddrs = toAddresses(payload.to);
      if (!toAddrs || toAddrs.length === 0) {
        return {
          data: null,
          error: { message: 'ses: at least one recipient required', name: 'SESError' },
        };
      }

      const headers = payload.headers
        ? Object.entries(payload.headers).map(([Name, Value]) => ({ Name, Value }))
        : undefined;

      // SES carries tags natively as EmailTags ({ Name, Value }[]). Names and
      // values are constrained by SES to ASCII alphanumerics, `_`, `-` (≤ 256
      // chars) — passed through unsanitized; a violating tag fails the send and
      // surfaces via the existing catch below (issue 13 M1).
      const emailTags = payload.tags?.map(({ name, value }) => ({ Name: name, Value: value }));

      // Fields SES genuinely cannot carry — make the drop visible in debug logs.
      if (payload.scheduledAt !== undefined) {
        debugEmails.debug('[ses] scheduledAt dropped (SES v2 SendEmail has no scheduled delivery): {scheduledAt}', {
          scheduledAt: payload.scheduledAt,
        });
      }
      if (payload.react != null) {
        debugEmails.debug('[ses] react dropped (SES requires pre-rendered html)');
      }

      let sdk: Awaited<ReturnType<typeof loadSdk>>;
      try {
        sdk = await loadSdk();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to load @aws-sdk/client-sesv2';
        return { data: null, error: { message, name: 'SESError' } };
      }
      const { client, SendEmailCommand } = sdk;
      const command = new SendEmailCommand({
        FromEmailAddress: payload.from,
        Destination: {
          ToAddresses: toAddrs,
          CcAddresses: toAddresses(payload.cc),
          BccAddresses: toAddresses(payload.bcc),
        },
        ReplyToAddresses: toAddresses(payload.replyTo),
        ...(emailTags ? { EmailTags: emailTags } : {}),
        Content: {
          Simple: {
            Subject: { Data: payload.subject, Charset: 'UTF-8' },
            Body: {
              Html: payload.html ? { Data: payload.html, Charset: 'UTF-8' } : undefined,
              Text: payload.text ? { Data: payload.text, Charset: 'UTF-8' } : undefined,
            },
            Headers: headers,
          },
        },
        ConfigurationSetName: options.configurationSetName,
      });

      try {
        const response = await client.send(command);
        const id = response.MessageId ?? '';
        debugEmails.debug('[ses] Sent ok id={id}', { id });
        return { data: { id }, error: null };
      } catch (err) {
        const error = err as { name?: string; message?: string };
        const name = error.name ?? 'SESError';
        const message = error.message ?? 'SES send failed';
        debugEmails.debug('[ses] Send failed: {failed} ({name})', { failed: message, name });
        return { data: null, error: { message, name } };
      }
    },
  };
}
