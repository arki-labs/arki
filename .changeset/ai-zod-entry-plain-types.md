---
'@arki/ai': minor
---

Zod schemas move to a new `@arki/ai/zod` entry. The capability, validation, transcription and structured-generation entries now expose plain TS types only, so their published types carry no Zod.

Each public type is now written as a plain TS type and is the source. Its runtime schema stays in the package and is locked to it by an exact two-way type test (`src/zod.test.ts`, `src/transcription.test.ts`), so the two cannot drift.

Breaking:

- `@arki/ai/capabilities/ask` no longer exports `askQuestionSchema`. Import it from `@arki/ai/zod`. `AskQuestion` stays.
- `@arki/ai/capabilities/queue` no longer exports `queueOrderSchema`. Import it from `@arki/ai/zod`. `QueueOrderInput` stays.
- `@arki/ai/capabilities/podhop` no longer exports `hopSelectionSchema`. Import it from `@arki/ai/zod`. `HopSelection['language']` is now `keyof typeof podHopVoices` (the same four languages), and `selectPodHopMoments` returns `Promise<HopSelection>`.
- `@arki/ai/capabilities/episode-analysis` no longer exports `transcriptDocumentSchema`, `passageSchema` or `analysisDocumentSchema`. Import them from `@arki/ai/zod` (the root `@arki/ai` still exports the first and the last).
- `@arki/ai/ai-service/structured-generation` no longer exports `CommonSchemas`. Import it from `@arki/ai/zod`. Each `StructuredGenerator` task returns a plain result type.
- `@arki/ai/validation` exports only the config and input types and `validateInput` / `validateInputAsync`. Its schemas (`qdrantConfigSchema`, `vectorProviderConfigSchema`, `searchSettingsSchema`, `searchOptionsSchema`, `ragServiceConfigSchema`, `aiServiceConfigSchema`, `generationOptionsSchema`, `documentSchema`, `documentsSchema`, `chatMessageSchema`) come from `@arki/ai/zod` or the root. `sanitizerConfigSchema` comes from `@arki/ai/safety` or the root.
- `@arki/ai/transcription`: `transcribeDiarizedAudio` takes `{ deepgramKey: string; transcriptionModel?: string }`, the same shape as before, written as a plain type.

Also: `DetectionPattern`, `PIIPattern` and `SanitizerConfig` (`./safety`) are plain TS types. As a result `./dot`, `./react` and `./react/index` no longer expose Zod, and their baseline entries are removed.

docs: README `Public imports` (`./validation`, `./zod`), `docs/reference.md`, `llms.txt` regenerated.
no demo impact: no demo imports these schemas.
