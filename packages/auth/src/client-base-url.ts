/**
 * Resolves the absolute base URL for a Better Auth client.
 *
 * Better Auth uses `new URL(path, baseURL)` internally to construct fetch
 * URLs. That constructor needs an **absolute** baseURL on both runtimes:
 *
 *   - SSR (no `window`): the env-driven absolute URL must be passed in via
 *     `serverUrl`. Without it, `beforeLoad` guards that call
 *     `authClient.getSession()` crash with "Failed to parse URL from
 *     /api/auth/get-session" because undici/Node `fetch` rejects relative
 *     URLs.
 *
 *   - Client (browser): always `window.location.origin`. Some apps'
 *     `getBaseUrl()` returns `''` in the browser so that callers
 *     concatenating `${getBaseUrl()}${path}` produce same-origin relative
 *     URLs for `<a href>` / `<img src>`. That's fine for HTML but breaks
 *     `new URL('/path', '')` with "fetch() URL is invalid".
 *
 * @param serverUrl Absolute URL used during SSR (typically `env.VITE_URL`
 *                  or the result of an app-level `getBaseUrl()`).
 */
export const resolveAuthClientBaseUrl = (serverUrl: string): string =>
  typeof window === 'undefined' ? serverUrl : window.location.origin;
