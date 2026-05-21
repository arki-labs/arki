import handler from '@tanstack/react-start/server-entry';

import { paraglideMiddleware } from './paraglide/server.js';

/**
 * Server fetch handler.
 *
 * Wraps TanStack Start's SSR handler with `paraglideMiddleware`, which:
 *   - detects the request's locale from URL/cookie/Accept-Language
 *   - sets it in `serverAsyncLocalStorage` so `getLocale()` works inside loaders
 *   - issues 307 redirects when the URL doesn't match the detected locale's
 *     localized form (e.g. cookie says `de` but URL is unprefixed)
 *   - exposes the de-localized request via the callback's `localizedRequest`
 *     argument — pass THAT to `handler.fetch` so the router's matcher sees
 *     canonical (locale-naïve) URLs like `/bmi` instead of `/de/bmi`
 *
 * Do not combine this with `rewrite: { input: deLocalizeUrl, output: localizeUrl }`
 * on the router — that double-translates the URL and emits 3xx responses
 * with empty `Location:` headers (blank-page bug). Pick one owner of i18n
 * URL translation; the project standard is Paraglide. See
 * .agents/skills/tanstack-start/i18n.md gotcha #5.
 *
 * For production with the Bun preset, this handler also needs to serve
 * static assets from `dist/client/`. See the "static assets return 404"
 * gotcha in .agents/skills/tanstack-start/SKILL.md for the full pattern.
 */
export default {
  fetch(request: Request): Promise<Response> {
    return paraglideMiddleware(request, ({ request: localizedRequest }) =>
      handler.fetch(localizedRequest),
    );
  },
};
