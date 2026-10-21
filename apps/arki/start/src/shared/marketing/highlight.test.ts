import { describe, expect, it } from 'vitest';

import { ALL_EXCERPTS } from './build-steps';
import { glossaryEntry } from './glossary';
import { tokenizeLines } from './highlight';

const kinds = (line: string) =>
  tokenizeLines([line])[0]
    ?.filter(token => token.kind !== 'plain' && token.text.trim() !== '')
    .map(token => `${token.kind}:${token.text}`);

describe('highlight', () => {
  // WHY: the highlighter only adds colour. If joining its tokens ever differs from the source, the page would show
  // code that is not the code in the file, and copying it would copy the wrong text.
  it('gives every excerpt back exactly when its tokens are joined', () => {
    for (const excerpt of ALL_EXCERPTS) {
      for (const part of excerpt.parts) {
        const joined = tokenizeLines(part.lines).map(line => line.map(token => token.text).join(''));
        expect(joined).toEqual(part.lines);
      }
    }
  });

  // WHY: each kind has its own colour, so a wrong class is a visible lie about the code (a call drawn as a type).
  it('tells calls, methods, keys, types, strings, numbers and comments apart', () => {
    expect(kinds('  .use(database) // order matters')).toEqual([
      'punct:.',
      'method:use',
      'bracket:(',
      'bracket:)',
      'comment:// order matters',
    ]);
    expect(kinds('  db: entrypointOnly(database.provides.db),')).toContain('key:db');
    expect(kinds('  db: entrypointOnly(database.provides.db),')).toContain('call:entrypointOnly');
    expect(kinds('  db: entrypointOnly(database.provides.db),')).toContain('prop:provides');
    expect(kinds('amount: z.int().positive() // 3')).toContain('method:positive');
    expect(kinds("const x: Pick<Deps, 'a'> = 3;")).toEqual(
      expect.arrayContaining(['keyword:const', 'type:Pick', 'type:Deps', "string:'a'", 'number:3']),
    );
    expect(kinds('`Order is already ${row.status}`')).toEqual(['template:`Order is already ${row.status}`']);
  });

  // WHY: rainbow brackets are only right if every opener and its closer share a depth.
  it('numbers brackets so a pair shares one depth', () => {
    const [line] = tokenizeLines(['f({ a: [1] })']);
    const depths = line?.filter(token => token.kind === 'bracket').map(token => `${token.text}${token.depth}`);
    expect(depths).toEqual(['(0', '{1', '[2', ']2', '}1', ')0']);
  });

  // WHY: a hover word must light only where it names the API: `.use(` yes, the plain word `use` or `features` as a
  // variable no.
  it('finds glossary words by what they name', () => {
    expect(glossaryEntry('use', 'method')).toBeDefined();
    expect(glossaryEntry('use', 'plain')).toBeUndefined();
    expect(glossaryEntry('features', 'plain')).toBeUndefined();
    expect(glossaryEntry('waitFor', 'method')).toBeDefined();
    expect(glossaryEntry('signal', 'key')).toBeDefined();
    expect(glossaryEntry('write', 'plain')).toBeDefined();
    expect(glossaryEntry('nothing', 'call')).toBeUndefined();
  });
});
