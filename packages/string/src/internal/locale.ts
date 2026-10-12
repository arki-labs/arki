/** Locale-independent by default; locale-sensitive only when a BCP 47 tag is passed explicitly. */

export function lower(text: string, locale: string | undefined): string {
  return locale === undefined ? text.toLowerCase() : text.toLocaleLowerCase(locale);
}

export function upper(text: string, locale: string | undefined): string {
  return locale === undefined ? text.toUpperCase() : text.toLocaleUpperCase(locale);
}
