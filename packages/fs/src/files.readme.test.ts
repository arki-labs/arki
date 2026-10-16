/**
 * README code stays true: every `ts` block in README.md is copied from
 * `examples/files/*.ts`, which the package typecheck compiles. A block edited
 * in the README alone fails here.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const examples = [read('../examples/files/server.ts'), read('../examples/files/client.ts')].join('\n');
const blocks = [...read('../README.md').matchAll(/```ts\n([\s\S]*?)```/g)].map(match => match[1]?.trim() ?? '');

describe('README.md', () => {
  it('has ts blocks to check', () => {
    expect(blocks.length).toBeGreaterThanOrEqual(6);
  });

  it.each(blocks.map((block, index) => [index + 1, block] as const))(
    'ts block %i is a verbatim piece of the examples',
    (_index, block) => {
      expect(examples).toContain(block);
    },
  );
});
