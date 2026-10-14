import { describe, expect, it } from 'vitest';

import { isLanguageCode } from './language.js';

// Pins the behavior callers rely on: the `{ res, message }` result object of
// `is-language-code`. Syntax is checked against the language subtag lists, so
// shape-valid tags with an unknown language are rejected.
describe('isLanguageCode', () => {
  it.each(['en', 'en-US', 'fr', 'fr-CA', 'ro', 'zh-CN', 'pt-BR', 'zh-Hant', 'EN', 'en-us'])('accepts %s', value => {
    expect(isLanguageCode(value)).toEqual({ res: true, message: null });
  });

  it.each([
    ['', 'Empty language tag string given.'],
    ['xx', 'Unrecognised language subtag, "xx".'],
    ['xx-NOPE-1', 'Unrecognised language subtag, "xx".'],
    ['123', 'Unrecognised language subtag, "123".'],
    ['en-USA', 'Language subtag "usa" is out of order.'],
    ['e', 'Starts with singleton, "e".'],
    ['en_US', 'Does not resemble a language tag.'],
  ])('rejects %j with a message', (value, message) => {
    expect(isLanguageCode(value)).toEqual({ res: false, message });
  });
});
