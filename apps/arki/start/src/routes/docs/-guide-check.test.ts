import { describe, expect, test } from 'vitest';

import { lastShellCommand } from './-guide-check';

const block = (language: string, lines: readonly string[]) =>
  `<figure><pre tabindex="0" data-language="${language}"><code data-language="${language}">${lines
    .map(line => `<span data-line=""><span style="--shiki-dark:#fff">${line}</span></span>`)
    .join('\n')}</code></pre></figure>`;

describe('lastShellCommand', () => {
  // The guides list shows "ends with <command>": the command a reader runs to check they are done.
  test('is the last shell block, not an earlier step or the expected-output block', () => {
    const html = [
      block('sh', ['docker build -t my-app .']),
      '<h2 id="check">Check it</h2>',
      block('sh', ['curl -fsS http://localhost:3000/api/health']),
      block('text', ['{"status":"ok"}']),
    ].join('\n');
    expect(lastShellCommand(html)).toBe('curl -fsS http://localhost:3000/api/health');
  });

  test('reads the text of the highlighted tokens, with entities decoded', () => {
    const html = block('sh', ['npx dot doctor --json | jq -r &#x27;.data.status&#x27; &amp;&amp; echo &lt;ok&gt;']);
    expect(lastShellCommand(html)).toBe("npx dot doctor --json | jq -r '.data.status' && echo <ok>");
  });

  // A block that explains a step first still ends with the line that runs.
  test('skips comment lines and takes the last command of the block', () => {
    expect(lastShellCommand(block('bash', ['# start it', 'docker run my-app', '', '# check', 'dot doctor']))).toBe(
      'dot doctor',
    );
  });

  test('is null when the guide has no shell block', () => {
    expect(lastShellCommand(block('ts', ['const a = 1;']))).toBeNull();
    expect(lastShellCommand('<p>No code.</p>')).toBeNull();
  });
});
