/**
 * Debug state logging. Why: a debug line must never change a test's outcome. `logState` and a context's
 * `state` used JSON.stringify, so a row with a bigint column (or a cycle) threw a TypeError and failed the
 * test only when DEBUG_TESTS was on.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { configureDebug, createDebugContext, logState } from './debug';

const lines: unknown[][] = [];
const record = (...line: unknown[]) => {
  lines.push(line);
};

afterEach(() => {
  configureDebug({ enabled: false });
  lines.length = 0;
});

describe('debug state', () => {
  it('logs a bigint as 12n and a circular value by its tag, without throwing', () => {
    configureDebug({ enabled: true, logger: record });
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;

    logState('row', { id: 12n });
    logState('loop', circular);
    createDebugContext('Rows').state('row', { id: 12n });

    expect(lines).toEqual([
      ['[STATE] row:', '{\n  "id": "12n"\n}'],
      ['[STATE] loop:', '[object Object]'],
      ['[STATE] [Rows] row:', '{\n  "id": "12n"\n}'],
    ]);
  });
});
