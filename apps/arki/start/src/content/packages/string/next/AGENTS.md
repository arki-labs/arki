AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/string

Grapheme-aware string functions with canonical encoding failures, one subpath per concern, and an immutable fluent wrapper. Read [docs/agent-guide.md](./docs/agent-guide.md) for tasks. When a doc and the code disagree, `src/index.ts` wins.

## Laws

1. The sole runtime dependency is `@arki/failure`, authorized for canonical encoding failures.
2. Positions and lengths count graphemes, not UTF-16 units. A function that cuts, pads, slices or measures must never split an emoji, a flag or a combining sequence.
3. Literal search and replace match only on grapheme boundaries, and replacement strings are literal. `$&` stays `$&`.
4. Results never depend on the machine locale. A locale only applies when the caller passes `{ locale }`.
5. Use ECMAScript 2022 plus Unicode property escapes only. No `Buffer`, `atob`, `btoa`, `TextEncoder`, `node:` imports or ES2023 array-copy methods. A lint rule and `src/runtime.test.ts` fail the build if that changes. Hermes is the floor.
6. `Intl.Segmenter` is the one feature check. The fallback scanner in `src/internal/` must match it. `src/internal/graphemes.fuzz.test.ts` compares both on seeded random strings.
7. Counting functions (`words`, `sentences`, `paragraphs`, readability, keywords) share one definition of a word and a sentence in `src/segment.ts`. Never write a second tokenizer.
8. Base64 decoding is strict. Whitespace, mixed alphabets, bad padding and nonzero unused bits return `InvalidBase64`. Invalid UTF-8 returns `InvalidUtf8`. `tryFromBase64` aliases `fromBase64`; it never returns `null`.
9. Encoding failures are canonical `@arki/failure` values. Other static misuse remains a `StringError` with a stable code, and each code in `STRING_ERROR_CODES` has JSDoc with `@fix` and `@verify`. Wrong runtime types are not checked and have no code.
10. Any path that was quadratic stays guarded by `src/performance.test.ts`, which compares a large input with a small one so it fails on any machine.
11. Never write benchmark numbers by hand. `bun run bench --write-readme` writes them from an idle machine.

## Changing this package

1. Pick the concern file (`src/case.ts`, `src/format.ts`, `src/slug.ts`, and so on). One concern per file, one subpath per concern.
2. Add the function, its test next to it, and its method in `src/fluent.ts` if it returns a string.
3. A new subpath needs an `exports` key in `package.json`, a top JSDoc line on the entry module, and a run of `bun ../../tooling/library/src/llms.ts --write`.
4. Test the Unicode edge, not only ASCII: a ZWJ emoji, a flag, a decomposed accent.
5. Update `examples/describe-post.ts` only with its test. The README mirrors its region, so run `arki-doc-examples --write` after an edit.
6. Add a changeset in `.changeset/`. Documentation-only changes use `patch` and the line `no demo impact: documentation and doc-example changes only, runtime behaviour unchanged`.

## Verify

```sh
bun run build
bun run typecheck
bun run test
bun run test:docs
bun run test:runtimes
bun ../../tooling/library/src/error-index.ts
bun ../../tooling/library/src/llms.ts --check
```
