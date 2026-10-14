import { describe, expect, it } from 'vitest';

import type { Replacements } from './slug.js';
import { rulesets, slugify, transliterate } from './slug.js';
import { chinese } from './slug/rules-cjk.js';

// Expectations taken from cocur/slugify's test suite (via the former @arki/slugify).
const cocur: readonly (readonly [string, string])[] = [
  [' a  b ', 'a-b'],
  ['Hello', 'hello'],
  ['Hello World', 'hello-world'],
  ['Привет мир', 'privet-mir'],
  ['Привіт світ', 'privit-svit'],
  ['Hello: World', 'hello-world'],
  ['H+e#l1l--o/W§o r.l:d)', 'h-e-l1l-o-w-o-r-l-d'],
  [': World', 'world'],
  ['Hello World!', 'hello-world'],
  ['Ä ä Ö ö Ü ü ẞ ß', 'ae-ae-oe-oe-ue-ue-ss-ss'],
  ['Á À á à É È é è Ó Ò ó ò Ñ ñ Ú Ù ú ù', 'a-a-a-a-e-e-e-e-o-o-o-o-n-n-u-u-u-u'],
  ['Â â Ê ê Ô ô Û û', 'a-a-e-e-o-o-u-u'],
  ['Â â Ê ê Ô ô Û 1', 'a-a-e-e-o-o-u-1'],
  ['°¹²³⁴⁵⁶⁷⁸⁹@₀₁₂₃₄₅₆₇₈₉', '0123456789at0123456789'],
  ['Mórë thån wørds', 'more-thaan-woerds'],
  ['Блоґ їжачка', 'blog-jizhachka'],
  ['фильм', 'film'],
  ['драма', 'drama'],
  ['Français Œuf où à', 'francais-oeuf-ou-a'],
  ['هذه هي اللغة العربية', 'hthh-hy-allght-alaarbyt'],
  ['مرحبا العالم', 'mrhba-alaaalm'],
  ['Één jaar', 'een-jaar'],
  ['tiếng việt rất khó', 'tieng-viet-rat-kho'],
  ['Nguyễn Đăng Khoa', 'nguyen-dang-khoa'],
  ['Zażółć żółcią gęślą jaźń', 'zazolc-zolcia-gesla-jazn'],
  ['Mężny bądź chroń pułk twój i sześć flag', 'mezny-badz-chron-pulk-twoj-i-szesc-flag'],
  ['ერთი ორი სამი ოთხი ხუთი', 'erti-ori-sami-otkhi-khuti'],
  ['अ ऒ न द', 'a-oii-na-tha'],
  ['Æ Ø Å æ ø å', 'ae-oe-aa-ae-oe-aa'],
  ['Übergrößenträger'.repeat(1000), 'uebergroessentraeger-'.repeat(1000).slice(0, -1)],
  ['my🎉'.repeat(5000), 'my-'.repeat(5000).slice(0, -1)],
  ['Č Ć Ž Š Đ č ć ž š đ', 'c-c-z-s-d-c-c-z-s-d'],
  ['Ą Č Ę Ė Į Š Ų Ū Ž ą č ę ė į š ų ū ž', 'a-c-e-e-i-s-u-u-z-a-c-e-e-i-s-u-u-z'],
];

describe('slugify', () => {
  it.each(cocur)('%s', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it('keeps the former @arki/slugify behaviour for existing callers', () => {
    expect(slugify(' Mihai Eminescu')).toBe('mihai-eminescu');
    expect(slugify('')).toBe('');
    expect(slugify('   ')).toBe('');
  });

  it('decamelizes and handles contractions', () => {
    expect(slugify('fooBar APISection FOO360 APIs')).toBe('foo-bar-api-section-foo-360-apis');
    expect(slugify('fooBar', { decamelize: false })).toBe('foobar');
    expect(slugify("Conway's Law don’t")).toBe('conways-law-dont');
    expect(slugify('Tom & Jerry ♥')).toBe('tom-and-jerry-love');
  });

  it('honours options', () => {
    expect(slugify('Hello World', { separator: '_' })).toBe('hello_world');
    expect(slugify('Hello World', { separator: '' })).toBe('helloworld');
    expect(slugify('Hello World', { lowercase: false })).toBe('Hello-World');
    expect(slugify('a.b.c', { preserveCharacters: ['.'] })).toBe('a.b.c');
    expect(() => slugify('a', { preserveCharacters: ['-'] })).toThrowError(/ARKI_STRING_E001/);
    expect(slugify('_private', { preserveLeadingUnderscore: true })).toBe('_private');
    expect(slugify('_private')).toBe('private');
    expect(slugify('trailing-', { preserveTrailingDash: true })).toBe('trailing-');
    expect(slugify('ä ö', { locale: 'sv' })).toBe('a-o');
    expect(slugify('ä ö', { locale: 'de' })).toBe('ae-oe');
    expect(slugify('æ', { locale: 'no' })).toBe('ae');
    expect(slugify('İstanbul', { locale: 'tr' })).toBe('istanbul');
    expect(slugify('x → y', { replacements: [['→', ' to ']] })).toBe('x-to-y');
    expect(slugify('ä', { replacements: [['ä', 'aa']] })).toBe('aa');
  });

  it('supports opt-in CJK rule sets', () => {
    expect(slugify('我是谁')).toBe('');
    expect(slugify('我是谁', { replacements: chinese })).toBe('wo-shi-shui');
  });

  it('exposes the curated rule sets', () => {
    expect(Object.keys(rulesets)).toContain('romanian');
    expect(rulesets.romanian).toContainEqual(['ș', 's']);
  });
});

/**
 * These cocur expectations never held in @arki/slugify either (its upstream applied
 * rules in a different order). Kept as `it.fails` so a change in behaviour is noticed.
 */
describe('known divergences from cocur', () => {
  it.fails('Greek digraphs', () => {
    expect(slugify('Ύπαρξη Αυτής η Σκουληκομυρμηγκότρυπα')).toBe('yparksi-aytis-i-skoylikomyrmigkotrypa');
  });
  it.fails('Burmese', () => {
    expect(slugify('နှစ်သစ်ကူးတွင် သတ္တဝါတွေ')).toBe('nhsatthsatkutwngat-thttwatwe');
  });
  it.fails('Yiddish', () => {
    expect(slugify('יאַן אַ טאָן יאָ')).toBe('yan-a-ton-io');
  });
});

describe('transliterate', () => {
  it('folds to Latin without slugging', () => {
    expect(transliterate('Привет, мир!')).toBe('Privet, mir!');
    expect(transliterate('crème brûlée')).toBe('creme brulee');
    expect(transliterate('Ærøskøbing')).toBe('AEroeskoebing');
    expect(transliterate('x – y — z')).toBe('x - y - z');
    expect(transliterate('é')).toBe('e');
    expect(transliterate('Straße', { locale: 'de' })).toBe('Strasse');
    expect(transliterate('🎉')).toBe('🎉');
  });
});

describe('separator is literal', () => {
  it('keeps $& as a separator and reuses compiled user tables', () => {
    expect(slugify('a b', { separator: '$&' })).toBe('a$&b');
    const table: Replacements = [['x', 'y']];
    expect(slugify('x x', { replacements: table })).toBe('y-y');
    expect(slugify('x', { replacements: table })).toBe('y');
  });
});
