const MAX_ERROR_LENGTH = 500;
/** Regexes run on at most this much input, so a huge error message costs bounded work. A secret cut at this edge is dropped by the final cap. */
const MAX_SCAN_LENGTH = MAX_ERROR_LENGTH * 4;

const REPLACEMENTS: readonly (readonly [RegExp, string])[] = [
  // user:password@ inside URLs
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@'],
  // Authorization: Bearer xxx, Bearer xxx
  [/\b(bearer|basic)\s+[\w.~+/=-]{8,}/gi, '$1 [REDACTED]'],
  // key=value / key: value / "key":"value" for secret-looking keys
  [
    /(["']?\b[\w-]*(?:password|passwd|secret|token|api[_-]?key|authorization|credential)[\w-]*\b["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
    '$1[REDACTED]',
  ],
  // well-known token shapes
  [/\b(?:sk|pk|rk|xox[abprs]|ghp|gho|github_pat)[-_][\w-]{12,}/g, '[REDACTED]'],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, '[REDACTED]'],
];

/** Strips credentials from an error message and caps its length. The message is shown in Foreman, so it must not leak secrets. */
export function redactSecrets(message: string): string {
  let result = message.length > MAX_SCAN_LENGTH ? message.slice(0, MAX_SCAN_LENGTH) : message;
  for (const [pattern, replacement] of REPLACEMENTS) result = result.replace(pattern, replacement);
  return result.length > MAX_ERROR_LENGTH ? `${result.slice(0, MAX_ERROR_LENGTH)}…` : result;
}
