# @arki/mail

Transactional email for TypeScript apps. One small client, several providers, a quota router that fails over when a provider hits its monthly limit.

The library never reads `process.env`. Your app reads its own env and passes the values in. Missing or invalid config throws a clear error at startup.

## Install

```sh
bun add @arki/mail
# then only the provider SDKs you use:
bun add resend                  # for the Resend provider
bun add @aws-sdk/client-sesv2   # for the SES provider
bun add react-email             # only if you use the bundled templates
```

`resend`, `@aws-sdk/client-sesv2` and `react-email` are optional peer dependencies. They load on first use. Unosend and Cloudflare Email Service use `fetch` and need nothing extra.

## Configure

```ts
import { createEmailClient } from '@arki/mail';

export const emails = createEmailClient({
  isDev: env.NODE_ENV === 'development', // required; true = log, never deliver
  resend: { apiKey: env.RESEND_API_KEY },
  unosend: { apiKey: env.UNOSEND_API_KEY, quotaPerMonth: 60_000 },
});

const { data, error } = await emails.send({
  to: 'reader@example.com',
  from: 'App <no-reply@example.com>',
  subject: 'Hello',
  html: '<p>Hi</p>',
});
```

`send()` never throws. It returns `{ data: { id }, error: null }` or `{ data: null, error: { name, message } }`.

The config is a Zod schema (`EmailClientConfigSchema`). Rules:

- `isDev` is required. There is no `NODE_ENV` fallback.
- At least one provider must be set.
- Keys must be non-empty strings. An empty key throws. It does not quietly turn the provider off.
- `kv` (optional) shares quota counters across replicas. See below.

Want full control? Build providers yourself and call `initEmails({ providers, isDev, store })`.

## Providers

| Provider                 | Entry                                             | Required config                       | Notes                                                                                                                                                                                                    |
| ------------------------ | ------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resend                   | `@arki/mail/providers/resend`                   | `resend: { apiKey }`                  | Needs the `resend` peer. Default quota 3 000/mo. Only provider that accepts `react`.                                                                                                                     |
| Unosend                  | `@arki/mail/providers/unosend`                  | `unosend: { apiKey }`                 | `fetch` only. Default quota 6 000/mo. Supports `scheduledAt`.                                                                                                                                            |
| Cloudflare Email Service | `@arki/mail/providers/cloudflare-email-service` | `cloudflare: { accountId, apiToken }` | `fetch` only. Beta. Token needs `Email Service: Edit`. Default quota 3 000/mo. Drops `tags`, `scheduledAt`, `react`.                                                                                     |
| Amazon SES               | `@arki/mail/providers/ses`                      | `ses: { region }`                     | Needs the `@aws-sdk/client-sesv2` peer. Optional `credentials` (else the AWS default chain), `configurationSetName`. No quota by default, so it is the unlimited fallback. Drops `scheduledAt`, `react`. |

When several are set, the router tries them in this order: Resend, Unosend, Cloudflare, SES.

Every provider passes one shared contract suite (`src/providers/provider-contract.ts`): send shape, error mapping (service error and network failure), and quota behaviour. To add a provider, implement `EmailProvider` and add it to `provider-contract.spec.ts`.

## Templates

React Email templates ship as subpath imports. Names are neutral and carry no brand.

| Template                            | Entry                                             | Props                                            |
| ----------------------------------- | ------------------------------------------------- | ------------------------------------------------ |
| Magic link (branded header, button) | `@arki/mail/react/templates/magic-link`         | `loginUrl`, `appName`, `appUrl`                  |
| Magic link (plain text link)        | `@arki/mail/react/templates/magic-link-minimal` | `loginUrl`, `appUrl`, `appKey`, `appDescription` |

```ts
import { render } from '@react-email/render';

import { MagicLinkEmail } from '@arki/mail/react/templates/magic-link';

const html = await render(MagicLinkEmail({ loginUrl: url, appName: 'My App', appUrl }));
```

Templates are not re-exported from the root entry, so the root stays JSX-free.

## Quota router

With two or more providers the client wraps them in `quotaRouter`. Each provider has a `quotaPerMonth`. The router sends through the first provider with quota left this month. A failed send does not use quota. If every quota is used, the last provider is used anyway, so mail is never silently dropped.

Counters are in memory by default and reset on restart. For several replicas, pass a KV store (anything with `get` and `set`, such as `@arki/kv`):

```ts
createEmailClient({ isDev, resend: { apiKey }, unosend: { apiKey: key2 }, kv });
// or: quotaRouter(providers, { store: kvQuotaStore(kv) })
```

## Logging

Debug logs use `getLogger('arki:mail')`. Enable with `DEBUG=arki:mail`.
