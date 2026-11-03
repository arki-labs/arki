# @arki/intl

## 0.2.0

### Minor Changes

- e6b9330: `@arki/testing`: `readManifest` returns `StackNotStarted` or `StackManifestInvalid` (`testing.stack_not_started`, `testing.stack_manifest_invalid`) instead of throwing; the manifest text is checked by a schema. The judge and embedder (`createJudge`, `createEmbedder`) return or raise `OllamaUnavailable` and `OllamaAnswerInvalid` (`testing.ollama_unavailable`, `testing.ollama_answer_invalid`), and the judge scorers turn a judge failure into an `unscorable` score. `setupGlobalTestContainers`, `stackSetup`, the `e2eTest` server fixture, `defineStack` and `RunningStack.stop` always stop what they started, even when a later step or a stop fails. `IntegrationTester.withTransaction` no longer swallows a lost connection. New `serveWorker` helper for the e2e server fixture.

  `@arki/contracts`: the root doc comment says which doors throw and which return; extra tests for `defineId().is` and `operationAt`.

  `@arki/intl`: `loadMessagesFromMultipleDictionaries` and `AppLocaleProvider` look locales up by own key, so `'__proto__'`, `'toString'` or `'constructor'` fall back to the default locale instead of throwing or merging prototype members.

### Patch Changes

- 8f873ae: Add `isLanguageCode` to `@arki/intl/language`. It checks a BCP 47 tag such as `en-US` against the language lists and returns the `is-language-code` result (`{ res, message }`). It moved here from `@arki/assert` with the same behavior.
