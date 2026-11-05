// Cross-runtime smoke test. Runs the BUILT entry on Hermes via `bun run test:runtimes`
// (the only engine this package claims). The RevenueCat native module is not present in the
// test host, so every store call must come back as a typed failure, never a raw rejection.

import { isFailure } from '@arki/failure';

import {
  getProOffering,
  OfferingsUnavailable,
  PurchaseFailed,
  purchasePackage,
  RestoreFailed,
  restorePurchases,
} from '../dist/src/index.js';

const offering = await getProOffering();
const purchase = await purchasePackage({});
const restored = await restorePurchases();

const checks = [
  [
    'offerings without the native store are a typed failure',
    isFailure(offering) && offering.code,
    'payments_native.offerings_unavailable',
  ],
  ['offerings failure matches its definition', OfferingsUnavailable.is(offering), true],
  ['a failed purchase is a typed failure', PurchaseFailed.is(purchase), true],
  ['purchase failure hides the SDK message', JSON.stringify(purchase).includes('native'), false],
  ['restore without the native store is a typed failure', RestoreFailed.is(restored), true],
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
