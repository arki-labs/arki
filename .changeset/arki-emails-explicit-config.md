---
'@arki/emails': minor
---

Explicit client config. `createEmailClientFromEnv` is replaced by `createEmailClient(config)`, validated with Zod (`EmailClientConfigSchema`). The library no longer reads `process.env`: `isDev` is a required option (no `NODE_ENV` fallback), keys come only from the config, and missing or invalid config throws a clear error. `initEmails` defaults `isDev` to `false`; the deprecated `send(apiKey, payload)` now takes `{ isDev }`. Templates are renamed to neutral names (`arki-magic-link` to `magic-link`, `notion-magic-link` to `magic-link-minimal`) and the branded demo templates (stripe, vercel, plaid) are removed. `resend`, `@aws-sdk/client-sesv2` and `react-email` become optional peer dependencies, loaded on first use. `resend` providers no longer throw on network failure. Logger category is now `arki:emails`. Adds a shared provider contract test suite and a README with a provider table.
