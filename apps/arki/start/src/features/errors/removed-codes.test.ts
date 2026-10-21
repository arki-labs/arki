import { describe, expect, it } from 'vitest';

import errorsFile from '~/generated/errors.json';
import { findRemovedCode, removedCodes } from './removed-codes';

describe('removed error codes', () => {
  const live = new Set(errorsFile.map(entry => entry.code));

  // WHY: the removed page tells a reader "use this code instead" and links to it. A replacement that is not in
  // errors.json would be a link to a 404.
  it('points every removed code at a replacement that exists', () => {
    for (const entry of removedCodes) {
      expect(live.has(entry.replacedBy), `${entry.code} -> ${entry.replacedBy}`).toBe(true);
    }
  });

  // WHY: `/errors/<code>` renders the live page first. A code that is both live and removed would hide one of
  // the two stories.
  it('lists no code that is also live', () => {
    for (const entry of removedCodes) expect(live.has(entry.code), entry.code).toBe(false);
  });

  it('finds a removed code by name and nothing else', () => {
    expect(findRemovedCode('DOT_CLI_E001')?.replacedBy).toBe('dot.app_not_found');
    expect(findRemovedCode('dot.app_not_found')).toBeNull();
  });
});
