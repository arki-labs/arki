---
'@arki/lock': patch
---

The README now says what React Native needs: lock tokens come from Web Crypto `getRandomValues`, so
install `react-native-get-random-values` first. Without it every lock call returns `RandomSourceUnavailable`
and the callback does not run. The smoke test proves both cases on Hermes. Lint fixes only in the key
encoding code; behaviour is unchanged.

no docs impact: README updated in this change.
no demo impact: no demo runs on React Native.
