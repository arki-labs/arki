# @arki/intl

Locale helpers for web apps. ISO language lookups, a bidirectional slug registry for localized URLs, message dictionary loading, and a TanStack Start locale provider built on [`use-intl`](https://next-intl.dev/docs/usage/configuration).

## Install

```sh
npm install @arki/intl
# or
bun add @arki/intl
```

`react` (18 or 19) is an optional peer. Only `@arki/intl/tanstack-start` needs it.

## Quick start

Look up a language, then resolve a localized URL.

```ts
import { getEnglishName } from '@arki/intl/language';
import { SlugRegistry } from '@arki/intl/slug-registry';

const registry = new SlugRegistry([
  { resourceId: 'bmi-calculator', resourceKind: 'tool', locale: 'en', slug: 'bmi-calculator' },
  { resourceId: 'bmi-calculator', resourceKind: 'tool', locale: 'de', slug: 'bmi-rechner' },
]);

export const german = getEnglishName('de'); // 'German'
export const localized = registry.getLocalizedUrl('bmi-calculator', 'de', 'en', '/health/bmi-calculator/'); // '/de/health/bmi-rechner/'
export const resourceId = registry.getResourceId('bmi-rechner', 'de'); // 'bmi-calculator'
```

## When not to use this

- You need pluralization, date or number formatting. Use `use-intl` directly. This package only mounts its provider.
- You need more than the built-in `en` and `de` messages from this package. Pass your own through `messages` or `featureDictionaries`.

## Runtime support

The language, slug registry and dictionary entries run on Node, Bun, Deno and browsers. The `tanstack-start` entry needs React.

<!-- runtimes:start -->
| Runtime | Result | Version tested | Date (UTC) |
| --- | --- | --- | --- |
| node | pass | v22.13.1 | 2026-11-05 |
| bun | pass | 1.4.2 | 2026-11-05 |
| deno | pass | 2.9.8 | 2026-11-05 |
| browser | pass | Chromium 156.0.8078.4 | 2026-11-05 |
| hermes | pass | V1 250829098.0.17 | 2026-11-05 |
<!-- runtimes:end -->

## Public imports

| Import | What |
| --- | --- |
| `@arki/intl/language` | Re-exports of `all-iso-language-codes` (`getName`, `getEnglishName`, `getNativeName`, `isValid`, `getAll639_1`, ...) and `isLanguageCode(tag)`, which checks a BCP 47 tag such as `en-US`. |
| `@arki/intl/slug-registry` | `SlugRegistry`: `getSlug(resourceId, locale)`, `getResourceId(slug, locale, scope?)`, `getLocalizedUrl(resourceId, targetLocale, defaultLocale, englishUrl)`. |
| `@arki/intl/dictionaries` | `loadMessagesFromMultipleDictionaries(locale, defaultLocale, featureDictionaries)`. Merges the built-in `en` and `de` messages with your feature dictionaries. |
| `@arki/intl/types` | Types `AppLocaleConfig` and `LocalizedResourceSlug`. |
| `@arki/intl/react` | Type `LinkComponent`: a link component type any router can satisfy. |
| `@arki/intl/tanstack-start` | `AppLocaleProvider` (picks the built-in messages for a locale), `LocaleProvider` and `useLocale`. |

## Failure behaviour

Lookups return `undefined` when nothing matches. `getLocalizedUrl` returns the English URL unchanged when the target locale is the default or has no slug. An unknown locale falls back to the default locale's messages, and keys such as `__proto__` never match.

## Observability

Renders in the app's own process and does no I/O of its own, so the app's spans cover it and the package adds none.

## Limits

Built-in messages exist for `en` and `de` only.

## Documentation

- [Agent guide](docs/agent-guide.md): the model, the task map, the rules that bite, the errors and how to verify.
- [`llms.txt`](llms.txt): the short map an agent reads first.
- [`AGENTS.md`](AGENTS.md): the laws for changing this package.

## Support

Questions and bugs: <https://github.com/arki-labs/arki/issues>. Include the package version and the locale involved.
