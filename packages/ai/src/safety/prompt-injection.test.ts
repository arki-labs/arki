/**
 * Prompt-injection checks must give the same answer on every call: a caller's `g` or `y` flag
 * used to keep `lastIndex` between calls, so the second identical attack passed.
 */
import { describe, expect, it } from 'vitest';

import { PromptInjectionDetector } from './prompt-injection';

const customOnly = (pattern: RegExp) => new PromptInjectionDetector([{ pattern, description: 'Custom attack' }], true);

describe('PromptInjectionDetector with caller patterns (F9)', () => {
  it('a g pattern detects the same attack on every call', () => {
    const detector = customOnly(/open the vault/gi);
    const attack = 'please open the vault now';

    for (let call = 0; call < 3; call++) {
      expect(detector.hasInjection(attack)).toBe(true);
      expect(detector.detect(attack)).toEqual([
        {
          type: 'prompt_injection',
          description: 'Custom attack',
          matchedText: 'open the vault',
          startIndex: 7,
          endIndex: 21,
        },
      ]);
    }
  });

  it('a y pattern detects an attack that is not at the start of the text', () => {
    const detector = customOnly(/open the vault/y);

    expect(detector.hasInjection('please open the vault')).toBe(true);
    expect(detector.detect('please open the vault')).toHaveLength(1);
  });
});
