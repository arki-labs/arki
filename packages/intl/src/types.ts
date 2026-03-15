/**
 * Configuration for a single locale supported by an app.
 *
 * Apps declare their supported locales via `AppLocaleConfig` entries in the
 * project config. The `publishable` flag controls whether the locale is
 * exposed to the public — unpublished locales are hidden from sitemap,
 * search, and routing, but can still be used internally for development.
 */
export type AppLocaleConfig = {
  /** ISO 639-1 code (e.g., 'en', 'de') */
  locale: string;
  /** BCP 47 language tag for Intl APIs (e.g., 'en-US', 'de-DE') */
  languageTag: string;
  /** Preferred measurement system for this locale */
  measurementSystem: 'metric' | 'imperial';
  /** Default ISO 4217 currency code for this locale (e.g., 'USD', 'EUR') */
  defaultCurrency: string;
  /** Whether this locale is published and served publicly */
  publishable: boolean;
};

/**
 * Maps a stable internal resource ID + locale to its localized public slug.
 *
 * Used by the slug registry for bidirectional resolution:
 * - Forward: `(resourceId, locale)` → `slug` (link generation)
 * - Reverse: `(locale, slug)` → `resourceId` (page loader resolution)
 */
export type LocalizedResourceSlug = {
  /** Stable English key used internally (e.g., 'bmi-calculator') */
  resourceId: string;
  /** The kind of resource this slug represents */
  resourceKind: 'category' | 'calculator' | 'alias' | 'variant' | 'post' | 'legal';
  /** The locale this slug belongs to */
  locale: string;
  /** The localized public slug (e.g., 'bmi-rechner' for German) */
  slug: string;
};
