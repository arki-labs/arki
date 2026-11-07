import { describe, expect, it } from 'vitest';

import { generateLlmsFullTxt } from './llms-txt';

const base = { name: 'Site', tagline: 'Tag', description: 'Desc' };

describe('generateLlmsFullTxt details', () => {
  // Why: item titles are outside text. A title such as `constructor` must not print a function's source as its detail.
  it.each(['constructor', 'toString', '__proto__'])('prints no inherited member for an item titled %s', title => {
    const text = generateLlmsFullTxt({
      ...base,
      sections: [{ heading: 'Tools', items: [{ title, url: 'https://x.test', description: 'd' }] }],
      details: {},
    });
    expect(text).not.toContain('function');
    expect(text).not.toContain('[native code]');
    expect(text).toContain(`### ${title}`);
  });

  it('still prints the detail written for an item title', () => {
    const text = generateLlmsFullTxt({
      ...base,
      sections: [{ heading: 'Tools', items: [{ title: 'constructor', url: 'https://x.test', description: 'd' }] }],
      details: { constructor: 'Its own detail.' },
    });
    expect(text).toContain('Its own detail.');
  });
});
