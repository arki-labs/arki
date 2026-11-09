// Cross-runtime smoke test. Runs the BUILT entries under Node, Bun and Deno via
// `bun run test:runtimes`. No Stripe account and no database: a webhook is signed with
// Stripe's own scheme and verified by the real service, money and tax checks run on values,
// and a RevenueCat event is projected into a recording write port. StripeProvider checks the same
// signature with Stripe's async check, which Bun, Deno and workers need (their crypto is async only).
// Entries: root and ./core (ids, tables), ./core/money, ./presets (RevenueCat projector),
// ./tax (tax-id format), ./dunning, ./refunds, ./repositories, ./env (loaded).

import { createHmac } from 'node:crypto';

import { isFailure } from '@arki/failure';

import * as core from '../dist/core/index.js';
import { fromMinorColumn, positiveMoneySchema, toMinorColumn } from '../dist/core/money.js';
import { InvalidWebhookSignature } from '../dist/core/providers/provider-error.js';
import { StripeProvider } from '../dist/core/providers/stripe-provider.js';
import { createWebhookSecurityService } from '../dist/core/security/webhook-security.js';
import * as dunning from '../dist/dunning/index.js';
import { createPlanId, paymentProviderValues, planIdSchema } from '../dist/index.js';
import { projectRevenueCatEvent, revenueCatWebhookSchema, verifyRevenueCatAuth } from '../dist/presets/index.js';
import * as refunds from '../dist/refunds/index.js';
import { checkTaxIdFormat } from '../dist/tax/tax-id.js';

import '../dist/repositories.js';
import '../dist/env.js';

const secret = 'whsec_smoke';
const payload = JSON.stringify({ id: 'evt_1', object: 'event', type: 'invoice.paid', data: { object: {} } });
const timestamp = Math.floor(Date.now() / 1000);
const sign = (body, at) => `t=${at},v1=${createHmac('sha256', secret).update(`${at}.${body}`).digest('hex')}`;
const options = { skipIpValidation: true };

const security = createWebhookSecurityService({ allowedIps: [], replayWindowSeconds: 300, maxRetries: 3 });
const good = await security.validateWebhook(
  'stripe',
  payload,
  sign(payload, timestamp),
  String(timestamp),
  '1.2.3.4',
  secret,
  options,
);
const replay = await security.validateWebhook(
  'stripe',
  payload,
  sign(payload, timestamp),
  String(timestamp),
  '1.2.3.4',
  secret,
  options,
);
const forged = await security.validateWebhook(
  'stripe',
  payload,
  sign(payload, timestamp).replace(/.$/, '0'),
  String(timestamp),
  '1.2.3.4',
  secret,
  options,
);
const stale = await security.validateWebhook(
  'stripe',
  payload,
  sign(payload, timestamp - 3600),
  String(timestamp - 3600),
  '1.2.3.4',
  secret,
  options,
);
const wrongIp = await security.validateWebhook(
  'stripe',
  payload,
  sign(payload, timestamp),
  String(timestamp),
  '9.9.9.9',
  secret,
);

// No request leaves the process: checking a webhook signature is local work
const stripe = new StripeProvider({ apiKey: 'sk_test_smoke', webhookSecret: secret, environment: 'sandbox' });
const stripeValid = await stripe.validateWebhook(payload, sign(payload, timestamp), String(timestamp), '1.2.3.4');
const stripeForged = await stripe.validateWebhook(
  payload,
  sign(payload, timestamp).replace(/.$/, '0'),
  String(timestamp),
  '1.2.3.4',
);
const stripeEvent = await stripe.constructWebhookEvent(payload, sign(payload, timestamp));
const stripeForgedEvent = await stripe.constructWebhookEvent(payload, sign(payload, timestamp).replace(/.$/, '0'));

const calls = [];
const writes = { syncSubscription: async input => (calls.push(input), {}) };
const event = revenueCatWebhookSchema.parse({
  event: { type: 'BILLING_ISSUE', app_user_id: 'usr_1', product_id: 'pro_monthly', original_transaction_id: 'tx_1' },
}).event;
const planId = createPlanId();
const projected = await projectRevenueCatEvent({
  writes,
  event,
  customer: { id: 'cus_1', userId: 'usr_1' },
  planId: isFailure(planId) ? 'pln_1' : planId,
});
const ignored = await projectRevenueCatEvent({
  writes,
  event: { ...event, type: 'TEST' },
  customer: { id: 'cus_1', userId: 'usr_1' },
  planId: 'pln_1',
});
const badWebhook = revenueCatWebhookSchema.safeParse({ event: { type: 5 } });

const money = fromMinorColumn(1999, 'usd');

const checks = [
  ['a correctly signed stripe webhook is valid', good.isValid, true],
  [
    'the same webhook twice is refused as a replay',
    `${replay.isValid}:${String(replay.error).includes('replay')}`,
    'false:true',
  ],
  ['a forged signature is refused', forged.isValid, false],
  ['a stale signature is refused', stale.isValid, false],
  [
    'an address outside the allow list is refused',
    `${wrongIp.isValid}:${String(wrongIp.error).includes('unauthorized IP')}`,
    'false:true',
  ],
  ['StripeProvider.validateWebhook accepts a correctly signed webhook', stripeValid.isValid, true],
  ['StripeProvider.validateWebhook answers a forged signature as not valid', stripeForged.isValid, false],
  ['StripeProvider.constructWebhookEvent returns the signed event', stripeEvent.id, 'evt_1'],
  [
    'StripeProvider.constructWebhookEvent returns payments.invalid_signature for a forged one',
    InvalidWebhookSignature.is(stripeForgedEvent),
    true,
  ],
  ['minor units round trip through money', toMinorColumn(money), 1999],
  ['money keeps its currency', `${money.currency}`, 'USD'],
  [
    'a zero amount is not a positive price',
    positiveMoneySchema.safeParse({ amount: '0', currency: 'USD' }).success,
    false,
  ],
  ['plan ids are created and parse', !isFailure(planId) && planIdSchema.safeParse(planId).success, true],
  ['stripe is a known provider', paymentProviderValues.includes('stripe'), true],
  [
    'eu vat format is checked',
    `${checkTaxIdFormat({ type: 'eu_vat', value: 'DE123456789', country: 'DE' }).format}/${checkTaxIdFormat({ type: 'eu_vat', value: 'DE12', country: 'DE' }).format}`,
    'valid/invalid',
  ],
  [
    'an unknown tax id type is reported as unknown',
    checkTaxIdFormat({ type: 'made_up', value: '1', country: 'DE' }).format,
    'unknown',
  ],
  [
    'revenuecat billing issue makes the subscription past_due',
    `${projected.handled}:${calls[0]?.status}`,
    'true:past_due',
  ],
  ['revenuecat events that change nothing are ignored', ignored.handled, false],
  ['a malformed revenuecat webhook is refused by its schema', badWebhook.success, false],
  [
    'revenuecat auth compares the secret',
    `${verifyRevenueCatAuth('abc', 'abc')}/${verifyRevenueCatAuth('abc', 'abd')}/${verifyRevenueCatAuth(null, 'abc')}`,
    'true/false/false',
  ],
  [
    'core, dunning and refunds export their tables',
    [core, dunning, refunds].every(entry => Object.keys(entry).length > 0),
    true,
  ],
];

const engine =
  typeof HermesInternal !== 'undefined'
    ? 'hermes'
    : typeof Deno !== 'undefined'
      ? `deno ${Deno.version.deno}`
      : typeof Bun !== 'undefined'
        ? `bun ${Bun.version}`
        : typeof navigator !== 'undefined' && navigator.userAgent && !navigator.userAgent.includes('Node')
          ? `browser ${navigator.userAgent}`
          : `node ${globalThis.process?.version ?? ''}`;

let failed = 0;
for (const [name, actual, expected] of checks) {
  if (actual !== expected) {
    failed++;
    console.error(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const summary = `${engine}: ${checks.length - failed}/${checks.length} smoke checks passed`;
if (failed > 0) {
  console.error(summary);
  if (typeof globalThis.process !== 'undefined') globalThis.process.exit(1);
  throw new Error(summary);
}
console.log(summary);
// Timers of the query client and the queue keep some engines alive after the checks end.
if (typeof globalThis.process !== 'undefined') globalThis.process.exit(0);
