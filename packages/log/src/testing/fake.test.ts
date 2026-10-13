import { describe, expect, it } from 'vitest';

import { configure, getLogger } from '../core/default.js';
import { LOG_ERROR_CODES, LogError } from '../core/errors.js';
import { memorySink } from '../core/sinks.js';
import { fakeLog, LogAssertionError } from './index.js';

// One configuration of the default instance for this file (Vitest isolates files).
const real = memorySink();
const audit = memorySink();
configure({
  channels: { real, audit },
  default: { level: 'info', channels: ['real'] },
  categories: { billing: { channels: ['audit'] } },
});
const log = getLogger('app');

function messageOf(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof LogAssertionError) return error.message;
    throw error;
  }
  throw new Error('expected the assertion to throw');
}

describe('fakeLog', () => {
  it('captures every level and category, and restore() gives back the previous configuration', () => {
    const fake = fakeLog();
    log.trace('trace is captured');
    getLogger('billing').error('refund over limit {amount}', { amount: 9000 });
    expect(fake.records.map(record => record.template)).toEqual(['trace is captured', 'refund over limit {amount}']);
    expect(real.records).toHaveLength(0);
    fake.restore();

    log.info('after restore');
    log.debug('dropped by the real info level');
    expect(real.records.map(record => record.template)).toEqual(['after restore']);
  });

  it('assertions pass on a match and fail with the captured records printed', () => {
    using fake = fakeLog();
    getLogger('billing').error('refund over limit {amount}', { amount: 9000 });
    log.to('slack').warn('paged');

    fake.assertLogged({ level: 'error', template: 'refund over limit {amount}', fields: { amount: 9000 } });
    fake.assertSentTo('audit', { level: 'error' });
    fake.assertSentTo('slack', { level: 'warn' });
    fake.assertNotLogged({ level: 'fatal' });

    expect(messageOf(() => fake.assertLogged({ level: 'error', fields: { amount: 1 } }))).toBe(
      [
        'Expected a record matching { level=error, fields={"amount":1} }.',
        'Captured records (2):',
        '  ERROR [billing] "refund over limit {amount}" → "refund over limit 9000" {"amount":9000} (to audit)',
        '  WARN [app] "paged" → "paged" (to slack)',
      ].join('\n'),
    );
    expect(messageOf(() => fake.assertNotLogged({ level: 'warn' }))).toContain('found: WARN [app] "paged"');
    expect(messageOf(() => fake.assertSentTo('real', { level: 'warn' }))).toContain('sent to channel "real"');
  });

  it('allows one fake at a time and blocks configure() while it is active', () => {
    using _fake = fakeLog();
    const codes: string[] = [];
    for (const attempt of [
      () => fakeLog(),
      () => configure({ channels: { real }, default: { level: 'info', channels: ['real'] } }),
    ]) {
      try {
        attempt();
      } catch (error) {
        if (error instanceof LogError) codes.push(error.code);
      }
    }
    expect(codes).toEqual([LOG_ERROR_CODES.fakeActive, LOG_ERROR_CODES.fakeActive]);
  });
});
