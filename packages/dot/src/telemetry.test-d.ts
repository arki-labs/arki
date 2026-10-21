/** Custom telemetry must never widen the operation's exact value/failure union. */
import { expectTypeOf } from 'vitest';

import { defineFailure } from '@arki/failure';

import type { KernelCtx } from './unit-contract.js';
import type { DotTelemetry } from './telemetry.js';
import { telemetryFor } from './telemetry.js';

const Refused = defineFailure('telemetry.type.refused');
const telemetry = telemetryFor({ name: 'catalog' });
expectTypeOf(telemetry.span('refusal', () => Refused())).toEqualTypeOf<ReturnType<typeof Refused>>();
declare const value: { readonly id: string } | ReturnType<typeof Refused>;
declare const pending: Promise<typeof value>;
expectTypeOf(telemetry.span('lookup', () => value)).toEqualTypeOf<typeof value>();
expectTypeOf(telemetry.span('lookup', () => pending)).toEqualTypeOf<typeof pending>();
expectTypeOf<KernelCtx['$telemetry']>().toEqualTypeOf<DotTelemetry>();
// @ts-expect-error Scope comes from a real unit, feature, or hook identity.
telemetryFor({ id: 'catalog' });
// @ts-expect-error OTel attributes do not accept nested user payloads.
telemetry.event('lookup', { payload: { secret: 'hidden' } });
// @ts-expect-error Metric values are numeric.
telemetry.counter('hits').add('one');
// @ts-expect-error Log levels use the logging package's canonical level definition.
telemetry.log('verbose', 'lookup');
