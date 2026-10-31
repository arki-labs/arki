/**
 * Caller-supplied safety patterns are scanned through one copy built here, so their flags cannot
 * change the result: `g` is always set (a scan visits every match, `matchAll` steps past empty
 * matches and always ends) and `y` is always cleared (a scan never sticks to `lastIndex`).
 *
 * @module safety/scan-regex
 */

/** A copy of `pattern` with `g` set and `y` cleared. Build it once, then scan with `matchAll`, `search` or `replace`. */
export function scanRegex(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, `${pattern.flags.replaceAll(/[gy]/g, '')}g`);
}
