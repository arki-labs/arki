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
    ABORT_SHIM,
    '(async () => {',
    esmBundle,
    `})().catch(error => { print('${HERMES_FAILURE_MARKER} ' + (error && error.stack ? error.stack : String(error))); });`,
    '',
  ].join('\n');
}
