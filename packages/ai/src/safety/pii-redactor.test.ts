/**
 * A caller's own PII pattern must neither hang the redactor nor slip past it, whatever flags it carries.
 */
import { describe, expect, it } from 'vitest';

import { PIIRedactor } from './pii-redactor';

const customOnly = (pattern: RegExp) =>
  new PIIRedactor([{ pattern, replacement: '[ID]', description: 'Internal id' }], true);

describe('PIIRedactor with caller patterns (F9)', () => {
  it('a pattern without the g flag ends and finds every match', () => {
    // WHY: `while (regex.exec(...))` on a non-global regex matched the first id forever.
    const redactor = customOnly(/ID-\d+/);

    const result = redactor.redact('ID-1 and ID-2');

    expect(result.piiCount).toBe(2);
    expect(result.redactedText).toBe('[ID] and [ID]');
    expect(redactor.detect('ID-1 and ID-2').map(issue => issue.matchedText)).toEqual(['ID-1', 'ID-2']);
  });

  it('a pattern that matches empty text ends', () => {
    const redactor = customOnly(/x*/g);

    expect(redactor.detect('abc').every(issue => issue.matchedText === '')).toBe(true);
    expect(redactor.redact('ab').redactedText).toBe('[ID]a[ID]b[ID]');
  });

  it('a sticky (y) pattern still finds a match that is not at the start, on every call', () => {
    // WHY: `y` pins the scan to lastIndex, so PII after the first character was missed.
    const redactor = customOnly(/ID-\d+/y);

    for (let call = 0; call < 2; call++) {
      expect(redactor.hasPII('see ID-7')).toBe(true);
      expect(redactor.redact('see ID-7').redactedText).toBe('see [ID]');
    }
  });
});

describe('PIIRedactor default email and street-address patterns (audit-2 #10)', () => {
  const redactor = new PIIRedactor();

  // Why: the patterns run on user text before it reaches a model; a rewrite for speed must still catch the same PII.
  it.each([
    ['My email is john@example.com', 'My email is [EMAIL REDACTED]'],
    ['Contact: -john.doe+tag@mail.example.co.uk.', 'Contact: -[EMAIL REDACTED].'],
    ['e.g.john@x.com', '[EMAIL REDACTED]'],
    [
      'first.last@sub-domain.example.com, second@ex.org;third@ex.net',
      '[EMAIL REDACTED], [EMAIL REDACTED];[EMAIL REDACTED]',
    ],
    ['a@b.com.x@y.com', '[EMAIL REDACTED].[EMAIL REDACTED]'],
    ['I live at 123 Main Street, Springfield, IL 62701', 'I live at [ADDRESS REDACTED]'],
    ['4567 Martin Luther King Jr Blvd, Apt 5, Oakland, CA 94601', '[ADDRESS REDACTED]'],
    ['7 Oak Ct, Austin, TX 78701 and 8 Pine Ln, Dallas, TX 75201', '[ADDRESS REDACTED] and [ADDRESS REDACTED]'],
  ])('redacts %j', (input, redacted) => {
    expect(redactor.redact(input).redactedText).toBe(redacted);
  });

  it.each(['x@y', 'foo@bar.c', 'no email here', '10 Downing Street, London'])('leaves %j alone', input => {
    expect(redactor.hasPII(input)).toBe(false);
  });

  // Why: a pattern that backtracks over the whole text from every start blocked the event loop for ~33 s on
  // 256 KB of '1 ', so one pasted log could stall the server.
  // Before the fix 256 KB of '1 ' took about 33 s: the time grew with the square of the length. Linear
  // scanning costs about 4x the time for 4x the text; quadratic costs 16x. Comparing two lengths keeps the
  // check true on a loaded machine, where any fixed time limit is not.
  function scanMs(text: string): number {
    const started = performance.now();
    expect(redactor.hasPII(text)).toBe(false);
    expect(redactor.detect(text)).toEqual([]);
    expect(redactor.redact(text).piiCount).toBe(0);
    return performance.now() - started;
  }

  it.each(['1 ', 'a.', 'aa.'])('text of %j with no PII scans in time that grows linearly with its length', unit => {
    const small = unit.repeat(Math.ceil(65_536 / unit.length));
    const large = unit.repeat(Math.ceil(262_144 / unit.length));
    // The fastest of three runs drops pauses from other work on the machine.
    const fastest = (text: string) => Math.min(scanMs(text), scanMs(text), scanMs(text));
    const smallMs = Math.max(fastest(small), 5);
    expect(fastest(large) / smallMs).toBeLessThan(10);
  });
});
