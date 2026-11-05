/**
 * What the React Native host gives a Hermes app but the bare `hermes` CLI does
 * not, plus the wrapper that lets a bundle with top-level `await` run there.
 * Everything here stands in for the host and does no more than the smoke tests
 * need; a library that needs more of the web platform must say so itself.
 */

/** Printed when the async main of a bundle rejects, so the runner can fail the leg (Hermes exits 0 on a lost rejection). */
export const HERMES_FAILURE_MARKER = 'ARKI_HERMES_UNCAUGHT';

/** `console` over `print`; the CLI has no `console`. */
const CONSOLE_SHIM = 'globalThis.console = { log: print, warn: print, error: print };';

/**
 * `setTimeout` / `clearTimeout` with real delays. The bare `hermes` CLI has a
 * `setTimeout` that ignores the delay and fires in call order, which is not what
 * the React Native host does. This one keeps a queue ordered by due time and
 * runs one due timer per microtask turn (polling `Date.now()` until one is due),
 * so promise continuations run between timers as they do on a real event loop.
 * Like Node and browsers, a delay under 1 ms counts as 1 ms.
 */
const TIMER_SHIM = `
{
  const timers = [];
  let nextId = 1;
  let polling = false;
  const poll = () => {
    polling = false;
    if (timers.length === 0) return;
    const now = Date.now();
    let best = -1;
    for (let i = 0; i < timers.length; i++) {
      const timer = timers[i];
      if (timer.due > now) continue;
      if (best < 0 || timer.due < timers[best].due || (timer.due === timers[best].due && timer.id < timers[best].id)) best = i;
    }
    if (best >= 0) {
      const timer = timers.splice(best, 1)[0];
      try {
        timer.callback(...timer.args);
      } catch (error) {
        print('${HERMES_FAILURE_MARKER} ' + (error && error.stack ? error.stack : String(error)));
      }
    }
    schedule();
  };
  const schedule = () => {
    if (polling || timers.length === 0) return;
    polling = true;
    Promise.resolve().then(poll);
  };
  globalThis.setTimeout = (callback, delay, ...args) => {
    const id = nextId++;
    timers.push({ id, due: Date.now() + Math.max(1, Number(delay) || 0), callback, args });
    schedule();
    return id;
  };
  globalThis.clearTimeout = id => {
    const index = timers.findIndex(timer => timer.id === id);
    if (index >= 0) timers.splice(index, 1);
  };
}
`;

/**
 * `queueMicrotask`, as React Native installs it: `Libraries/Core/setUpTimers.js`
 * polyfills it with `Libraries/Core/Timers/queueMicrotask.js` (a resolved
 * promise's `then`, with a throw reported on a later timer), or with the native
 * one in bridgeless mode. Installed only when missing.
 */
const QUEUE_MICROTASK_SHIM = `
if (typeof globalThis.queueMicrotask !== 'function') {
  const resolved = Promise.resolve();
  globalThis.queueMicrotask = callback => {
    if (typeof callback !== 'function') throw new TypeError('The argument to queueMicrotask must be a function.');
    resolved.then(callback).catch(error => setTimeout(() => { throw error; }, 0));
  };
}
`;

/**
 * `performance.now()`, as React Native installs it when the native Performance
 * module is absent: `Libraries/Core/setUpPerformance.js` sets a `performance`
 * whose `now` reads `nativePerformanceNow` or `Date.now`, with no-op marks and
 * measures. Installed only when missing.
 */
const PERFORMANCE_SHIM = `
if (typeof globalThis.performance === 'undefined') {
  globalThis.performance = {
    mark: () => {},
    clearMarks: () => {},
    measure: () => {},
    clearMeasures: () => {},
    now: () => (globalThis.nativePerformanceNow || Date.now)(),
  };
}
`;

/**
 * `URL`, as React Native installs it: `Libraries/Core/setUpXHR.js` polyfills
 * the global with `Libraries/Blob/URL.js`. This is that class from React Native
 * 0.86 (MIT, Meta), without blob URLs and `searchParams`: string-based, with
 * regex getters, and a constructor that does not validate an absolute URL.
 * Installed only when missing.
 */
const URL_SHIM = String.raw`
if (typeof globalThis.URL !== 'function') {
  const validateBaseUrl = url =>
    /^(?:(?:(?:https?|ftp):)?\/\/)(?:(?:[1-9]\d?|1\d\d|2[01]\d|22[0-3])(?:\.(?:1?\d{1,2}|2[0-4]\d|25[0-5])){2}(?:\.(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-4]))|(?:(?:[a-z0-9¡-￿][a-z0-9¡-￿_-]{0,62})?[a-z0-9¡-￿]\.)*(?:[a-z¡-￿]{2,}\.?))(?::\d{2,5})?(?:[/?#]\S*)?$/.test(url);
  class URL {
    constructor(url, base) {
      let baseUrl = null;
      if (!base || validateBaseUrl(url)) {
        this._url = url;
        if (this._url.includes('#')) {
          const split = this._url.split('#');
          const website = split[0].split('://')[1];
          if (!website.includes('/')) this._url = split.join('/#');
        }
        if (!this._url.endsWith('/') && !(this._url.includes('?') || this._url.includes('#'))) {
          const afterProtocol = this._url.split('://')[1];
          if (afterProtocol && !afterProtocol.includes('/')) this._url += '/';
        }
      } else {
        if (typeof base === 'string') {
          baseUrl = base;
          if (!validateBaseUrl(baseUrl)) throw new TypeError('Invalid base URL: ' + baseUrl);
        } else {
          baseUrl = base.toString();
        }
        if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, baseUrl.length - 1);
        if (!url.startsWith('/')) url = '/' + url;
        if (baseUrl.endsWith(url)) url = '';
        this._url = baseUrl + url;
      }
    }
    get hash() {
      const match = this._url.match(/#([^/]*)/);
      return match ? '#' + match[1] : '';
    }
    get host() {
      const hostMatch = this._url.match(/^https?:\/\/(?:[^@]+@)?([^:/?#]+)/);
      const portMatch = this._url.match(/:(\d+)(?=[/?#]|$)/);
      return hostMatch ? hostMatch[1] + (portMatch ? ':' + portMatch[1] : '') : '';
    }
    get hostname() {
      const match = this._url.match(/^https?:\/\/(?:[^@]+@)?([^:/?#]+)/);
      return match ? match[1] : '';
    }
    get href() {
      return this.toString();
    }
    get origin() {
      const match = this._url.match(/^(https?:\/\/[^/]+)/);
      return match ? match[1] : '';
    }
    get password() {
      const match = this._url.match(/https?:\/\/.*:(.*)@/);
      return match ? match[1] : '';
    }
    get pathname() {
      const match = this._url.match(/https?:\/\/[^/]+(\/[^?#]*)?/);
      return match ? match[1] || '/' : '/';
    }
    get port() {
      const match = this._url.match(/:(\d+)(?=[/?#]|$)/);
      return match ? match[1] : '';
    }
    get protocol() {
      const match = this._url.match(/^([a-zA-Z][a-zA-Z\d+\-.]*):/);
      return match ? match[1] + ':' : '';
    }
    get search() {
      const match = this._url.match(/\?([^#]*)/);
      return match ? '?' + match[1] : '';
    }
    get username() {
      const match = this._url.match(/^https?:\/\/([^:@]+)(?::[^@]*)?@/);
      return match ? match[1] : '';
    }
    toJSON() {
      return this.toString();
    }
    toString() {
      return this._url;
    }
  }
  globalThis.URL = URL;
}
`;

/**
 * A minimal `AbortController` / `AbortSignal` (React Native provides the real
 * ones). Installed only when missing. Has `aborted`, `reason`, `onabort`,
 * `addEventListener` / `removeEventListener` for `abort` (with `once`),
 * `throwIfAborted` and `AbortSignal.abort`. No `timeout`, no `any`.
 */
const ABORT_SHIM = `
if (typeof globalThis.AbortController !== 'function') {
  const TOKEN = {};
  const abortError = () => {
    const error = new Error('This operation was aborted');
    error.name = 'AbortError';
    return error;
  };
  class AbortSignal {
    constructor(token) {
      if (token !== TOKEN) throw new TypeError('Illegal constructor');
      this.aborted = false;
      this.reason = undefined;
      this.onabort = null;
      this.listeners = [];
    }
    addEventListener(type, listener, options) {
      if (type !== 'abort') return;
      const once = typeof options === 'object' && options !== null && options.once === true;
      if (!this.listeners.some(entry => entry.listener === listener)) this.listeners.push({ listener, once });
    }
    removeEventListener(type, listener) {
      if (type !== 'abort') return;
      this.listeners = this.listeners.filter(entry => entry.listener !== listener);
    }
    throwIfAborted() {
      if (this.aborted) throw this.reason;
    }
    static abort(reason) {
      const controller = new AbortController();
      controller.abort(reason);
      return controller.signal;
    }
  }
  class AbortController {
    constructor() {
      this.signal = new AbortSignal(TOKEN);
    }
    abort(reason) {
      const signal = this.signal;
      if (signal.aborted) return;
      signal.aborted = true;
      signal.reason = reason === undefined ? abortError() : reason;
      const event = { type: 'abort', target: signal };
      if (typeof signal.onabort === 'function') signal.onabort(event);
      for (const entry of signal.listeners.slice()) {
        if (entry.once) signal.removeEventListener('abort', entry.listener);
        entry.listener(event);
      }
    }
  }
  globalThis.AbortController = AbortController;
  globalThis.AbortSignal = AbortSignal;
}
`;

/**
 * The script Hermes runs for an ESM bundle: host shims first, then the bundle
 * inside an async arrow so top-level `await` works. A rejection prints
 * `HERMES_FAILURE_MARKER` and the error.
 */
export function hermesScript(esmBundle: string): string {
  return [
    CONSOLE_SHIM,
    TIMER_SHIM,
    QUEUE_MICROTASK_SHIM,
    PERFORMANCE_SHIM,
    URL_SHIM,
    ABORT_SHIM,
    '(async () => {',
    esmBundle,
    `})().catch(error => { print('${HERMES_FAILURE_MARKER} ' + (error && error.stack ? error.stack : String(error))); });`,
    '',
  ].join('\n');
}
