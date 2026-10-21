import { describe, expect, it } from 'vitest';

import {
  defaultFirst,
  fileReason,
  formatBytes,
  formatPlanDate,
  newCommand,
  summarizeOperations,
} from './-dot-new-plan';

describe('dot new plan helpers', () => {
  it('puts the default template first and keeps the rest in order', () => {
    const ordered = defaultFirst([{ template: 'minimal' }, { template: 'other' }, { template: 'stack' }]);
    expect(ordered.map(entry => entry.template)).toEqual(['stack', 'minimal', 'other']);
  });

  it('writes the command a reader would type: the default needs no flag', () => {
    expect(newCommand('stack', 'arki-app')).toBe('dot new arki-app');
    expect(newCommand('minimal', 'arki-app')).toBe('dot new arki-app --template minimal');
  });

  it('formats sizes and the UTC date', () => {
    expect(formatBytes(48)).toBe('48 B');
    expect(formatBytes(2529)).toBe('2.5 KB');
    expect(formatPlanDate('2026-10-21T23:59:59.000Z')).toBe('21 Oct 2026');
  });

  it('says when a plan changes files that already exist', () => {
    expect(summarizeOperations([{ action: 'create', contentBytes: 1024 }])).toEqual({
      files: 1,
      size: '1.0 KB',
      ownership: 'all new, all yours to edit',
    });
    expect(
      summarizeOperations([
        { action: 'create', contentBytes: 1 },
        { action: 'update', contentBytes: 1 },
      ]).ownership,
    ).toBe('1 change existing files');
  });

  it('hides the generic scaffold reason', () => {
    expect(fileReason('Scaffold file: package.json')).toBe('');
    expect(fileReason('Standard ignores')).toBe('Standard ignores');
  });
});
