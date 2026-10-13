---
'@arki/string': patch
---

Faster `camelCase` and `pascalCase`: capitalizing a word no longer starts `Intl.Segmenter` when the first letter is plain Latin text (about 12× faster on mixed identifiers).

Faster case conversion on ASCII text: `caseWords` and every case function built on it split ASCII input in one pass instead of five regular expressions, with the same tokens.

Faster `truncate` and `length`: text below U+0300 (ASCII and Latin-1/Latin Extended letters) is counted without `Intl.Segmenter`, and `truncate` reads only the first `maxLength + 1` graphemes instead of segmenting the whole text.
