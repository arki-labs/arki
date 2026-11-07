# Agent guide: @arki/intl

Read `llms.txt` first for the map. This guide is the detail. When this guide and the code disagree, the entry files under `src/` win.

## The model

1. `@arki/intl/language` re-exports `all-iso-language-codes` lookups and adds `isLanguageCode(tag)` for BCP 47 tags such as `en-US`.
2. `@arki/intl/slug-registry` holds `SlugRegistry`. It maps a resource id and a locale to a slug, and back.
3. `@arki/intl/dictionaries` merges the built-in `en` and `de` messages with your feature dictionaries. It returns a `DictionaryLoadFailed` failure when a dictionary or loader rejects.
4. `@arki/intl/types` and `@arki/intl/react` hold types only.
5. `@arki/intl/tanstack-start` mounts the `use-intl` provider: `AppLocaleProvider`, `LocaleProvider` and `useLocale`.
6. Nothing here throws for a missing match. The answer is `undefined` or a fallback.

## Task map

### Look up a language name

1. `getEnglishName('de')` gives `'German'`. `getNativeName` gives the name in its own language.
2. `isLanguageCode(tag)` checks a BCP 47 tag before you trust it.

### Build a localized URL

1. `new SlugRegistry(slugs)` with `{ resourceId, resourceKind, locale, slug }` entries. `scope` is optional.
2. `registry.getLocalizedUrl(resourceId, targetLocale, defaultLocale, englishUrl)` gives the URL.
3. To go back, `registry.getResourceId(slug, locale, scope?)`. Pass `scope` when the same slug exists under more than one URL segment.

### Merge messages

1. `loadMessagesFromMultipleDictionaries(locale, defaultLocale, featureDictionaries)`.
2. Pass messages for any locale beyond `en` and `de` yourself.

### Mount the locale in TanStack Start

1. Wrap the app in `AppLocaleProvider`. It picks the built-in messages for a locale.
2. Read the locale with `useLocale`.

## Rules that bite

- Lookups return `undefined` when nothing matches. Handle it.
- `getLocalizedUrl` returns the English URL when the target is the default locale or has no slug.
- Built-in messages exist for `en` and `de` only.
- An unknown locale falls back to the default locale's messages.
- No plurals, dates or numbers. Use `use-intl`.
- Only `@arki/intl/tanstack-start` needs `react`.

## Errors

This package defines no error codes. Every lookup returns `undefined` or a fallback.

| Situation            | Result                                                   | What to do                                     |
| -------------------- | -------------------------------------------------------- | ---------------------------------------------- |
| No slug for a locale | `getSlug` returns `undefined`.                           | Fall back to the English URL, or add the slug. |
| Unknown locale       | The default locale's messages.                           | Add messages for the locale.                   |
| No language match    | The `all-iso-language-codes` lookup returns `undefined`. | Check the code with `isLanguageCode`.          |

## Verify

```sh
bun run build && bun run typecheck && bun run lint && bun run test
bun run test:docs
bun run test:runtimes
bun ../../tooling/library/src/llms.ts --check
```
