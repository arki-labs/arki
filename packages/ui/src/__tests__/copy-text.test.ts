import { describe, expect, it } from 'vitest';

import { copyText } from '../copy-text';

describe('copyText', () => {
  it('reports copied when the clipboard takes the text', async () => {
    const written: string[] = [];
    const clipboard = {
      writeText: (text: string) => {
        written.push(text);
        return Promise.resolve();
      },
    };
    expect(await copyText('const a = 1;', clipboard)).toBe('copied');
    expect(written).toEqual(['const a = 1;']);
  });

  it('reports failed, and does not reject, when the browser refuses the write', async () => {
    const clipboard = { writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) };
    expect(await copyText('x', clipboard)).toBe('failed');
  });

  it('reports failed when there is no clipboard, as in node, a server render, or an insecure page', async () => {
    expect(await copyText('x')).toBe('failed');
  });

  it('reports failed when writeText throws before it returns a promise', async () => {
    const clipboard = {
      writeText: (): Promise<void> => {
        throw new TypeError('not focused');
      },
    };
    expect(await copyText('x', clipboard)).toBe('failed');
  });
});
