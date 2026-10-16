// Cross-runtime smoke test. Runs the BUILT package (dist/) under Node, Bun and Deno via
// `bun run test:runtimes`. It exercises the portable entries once each, with a fake fetch;
// the unit tests cover the details.

import { resend } from '../dist/http/resend.js';
import { defineTemplate, failover, inMemoryQuotaStore, logTransport, MAIL_ERROR_CODES, mailer } from '../dist/index.js';
import { magicLink } from '../dist/templates/auth.js';

/** A hand-written Standard Schema: the smoke test needs no validator library. */
const nameSchema = {
  '~standard': {
    version: 1,
    vendor: 'smoke',
    validate: value =>
      typeof value === 'object' && value !== null && typeof value.name === 'string'
        ? { value: { name: value.name } }
        : { issues: [{ message: 'name is required' }] },
  },
};
const hello = defineTemplate({
  name: 'hello',
  input: nameSchema,
  subject: data => `Hello ${data.name}`,
  text: data => `Hi ${data.name}`,
});

const logged = await mailer({ transport: logTransport(), from: 'hi@app.dev' }).send(
  hello,
  { name: 'Ada' },
  { to: 'ada@example.com' },
);
const refused = await mailer({ transport: logTransport(), from: 'hi@app.dev' }).send(hello, {}, { to: 'a@b.c' });

const requests = [];
const fakeFetch = (url, init) => {
  requests.push({ url: String(url), key: new Headers(init.headers).get('idempotency-key') });
  return Promise.resolve(Response.json({ id: 're_123' }, { status: 200 }));
};
const viaResend = await mailer({ transport: resend({ apiKey: 're_test', fetch: fakeFetch }), from: 'hi@app.dev' }).send(
  hello,
  { name: 'Ada' },
  { to: 'ada@example.com', idempotencyKey: 'k1' },
);

const store = inMemoryQuotaStore();
const capped = resend({ apiKey: 're_test', quotaPerMonth: 0, fetch: fakeFetch });
const overQuota = await mailer({ transport: failover([capped], { store }), from: 'hi@app.dev' }).send(
  hello,
  { name: 'Ada' },
  { to: 'ada@example.com' },
);

const link = await mailer({ transport: logTransport(), from: 'hi@app.dev' }).render(magicLink, {
  appName: 'Acme',
  url: 'https://acme.dev/l/1',
});
const badLink = await mailer({ transport: logTransport(), from: 'hi@app.dev' }).render(magicLink, {
  appName: 'Acme',
  url: 'javascript:alert(1)',
});

const checks = [
  ['log transport reports simulated', logged.data?.status, 'simulated'],
  ['schema refusal is E003', refused.error?.code, MAIL_ERROR_CODES.invalidInput],
  ['resend returns the provider id', viaResend.data?.id, 're_123'],
  ['resend forwards the idempotency key', requests[0]?.key, 'k1'],
  ['over quota sends nothing (E004)', overQuota.error?.code, MAIL_ERROR_CODES.quotaExhausted],
  ['over quota made no request', requests.length, 1],
  ['magic link renders a text part with the url', link.data?.text.includes('https://acme.dev/l/1'), true],
  ['magic link refuses a javascript: url', badLink.error?.code, MAIL_ERROR_CODES.invalidInput],
];

const runtime =
  typeof Deno !== 'undefined'
    ? `deno ${Deno.version.deno}`
    : typeof Bun !== 'undefined'
      ? `bun ${Bun.version}`
      : typeof navigator !== 'undefined' && navigator.userAgent && !navigator.userAgent.includes('Node')
        ? `browser ${navigator.userAgent}`
        : `node ${globalThis.process?.versions?.node}`;

let failed = 0;
for (const [name, actual, expected] of checks) {
  if (actual !== expected) {
    failed++;
    console.error(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const summary = `${runtime}: ${checks.length - failed}/${checks.length} smoke checks passed`;
if (failed > 0) {
  console.error(summary);
  if (typeof globalThis.process !== 'undefined') globalThis.process.exit(1);
  throw new Error(summary);
}
console.log(summary);
