import slugifyImp from '@sindresorhus/slugify';

// Using pinyin to convert Chinese characters to pinyin
// it fails on Vercel because of
// ../../../node_modules/@node-rs/jieba-linux-x64-gnu/jieba.linux-x64-gnu.node
//Module parse failed: Unexpected character '' (1:0)
//You may need an appropriate loader to handle this file type, currently no loaders are configured to process this file. See https://webpack.js.org/concepts#loaders
//(Source code omitted for this binary file)
//
//Import trace for requested module:
//../../../node_modules/@node-rs/jieba-linux-x64-gnu/jieba.linux-x64-gnu.node
//../../../node_modules/@node-rs/jieba/index.js
//../../../node_modules/pinyin/esm/segment.js
//../../../node_modules/pinyin/esm/pinyin.js
//../../../packages/text/slugify/src/slugify.ts
// import pinyin from 'pinyin/esm/pinyin';

import { rules } from './rules.js';

// https://github.com/cocur/slugify/blob/main/src/Slugify.php
const rulesets = [
  'default',
  // Languages are preferred if they appear later, list is ordered by number of
  // websites in that language
  // https://en.wikipedia.org/wiki/Languages_used_on_the_Internet#Content_languages_for_websites
  'yiddish',
  'armenian',
  'azerbaijani',
  'burmese',
  'hindi',
  'georgian',
  'norwegian',
  'vietnamese',
  'ukrainian',
  'latvian',
  'finnish',
  'greek',
  'czech',
  'arabic',
  'slovak',
  'turkish',
  'polish',
  'german',
  'russian',
  'romanian',
] as const;

const rulesMap = new Map<string, string>();

for (const ruleset of rulesets) {
  const rulesetRules = rules[ruleset];
  for (const rule of Object.entries(rulesetRules)) {
    rulesMap.set(rule[0], rule[1]);
  }
}

const customReplacements = [...rulesMap.entries()];

export function slugify(words: string): string {
  // const pinyinWords = pinyin(words, {
  //   style: pinyin.STYLE_NORMAL,
  //   segment: true,
  // })
  //   .flat()
  //   .join(' ');

  return slugifyImp(words, {
    customReplacements,
  });
}
