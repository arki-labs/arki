import type { LevelInput } from './levels.js';
import type { BoundFields } from './record.js';
import type { FieldsArg } from './template.js';
import type {
  CategoryRule,
  ContextStore,
  FieldInput,
  Fields,
  LogConfig,
  LogRecord,
  Processor,
  Sink,
  TraceContext,
  TraceSource,
  Value,
} from './types.js';
import { alreadyConfiguredError, fakeActiveError, staleHandleError, unknownChannelError } from './errors.js';
import { Level, toLevel } from './levels.js';
import { deliver, syncContext } from './pipeline.js';
import { EMPTY_FIELDS, LogEntry } from './record.js';
import { reportFailure } from './report.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Register your app's logging handle to type-check channel names in `to()`
 * (RFC §8.4):
 *
 * ```ts
 * declare module '@arki/log' {
 *   interface Register { logging: typeof logging }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions, @typescript-eslint/no-empty-object-type -- an interface, so apps fill it in by module augmentation
export interface Register {}

/** The app's channel names once `Register` is declared; any string before that. */
export type ChannelName = Register extends { logging: Configured<infer C> } ? C : string;

/** A structured event (RFC §5.5). */
export type LogEvent = {
  readonly level: LevelInput;
  readonly eventName: string;
  readonly body?: Value;
  readonly fields?: Fields;
};

/** A logger (RFC §3). `Bound` holds the keys bound with `.with()`, which satisfy placeholders. */
export type Logger<Bound extends string = never> = {
  readonly category: string;
  trace<T extends string>(template: T, ...fields: FieldsArg<T, Bound>): void;
  debug<T extends string>(template: T, ...fields: FieldsArg<T, Bound>): void;
  info<T extends string>(template: T, ...fields: FieldsArg<T, Bound>): void;
  warn<T extends string>(template: T, ...fields: FieldsArg<T, Bound>): void;
  error<T extends string>(template: T, ...fields: FieldsArg<T, Bound>): void;
  /** Logs an error; the template is the error's message. */
  error(error: Error, fields?: FieldInput): void;
  fatal<T extends string>(template: T, ...fields: FieldsArg<T, Bound>): void;
  /** Logs an error; the template is the error's message. It only writes; it never exits. */
  fatal(error: Error, fields?: FieldInput): void;
  log<T extends string>(level: LevelInput, template: T, ...fields: FieldsArg<T, Bound>): void;
  isEnabled(level: LevelInput): boolean;
  emit(event: LogEvent): void;
  /** A logger with bound fields. The original is unchanged. */
  with<F extends Fields>(fields: F): Logger<Bound | (keyof F & string)>;
  /** Extends the category path: `'arki:kv'` → `'arki:kv:redis'`. */
  child(name: string): Logger<Bound>;
  /** Stamps this trace on every record. */
  withTrace(trace: TraceContext): Logger<Bound>;
  /** Sends records only to these channels, instead of the category's channels. */
  to(...channels: readonly [ChannelName, ...ChannelName[]]): Logger<Bound>;
};

/** Type-only key that carries a handle's channel names to `Register`. Never set at runtime. */
declare const CHANNELS: unique symbol;

/** The handle `configure()` returns (RFC §8.1). */
export type Configured<C extends string> = {
  readonly [CHANNELS]?: C;
  flush(): Promise<void>;
  /** Flushes, then closes every sink. The instance is then unconfigured again. */
  close(options?: { readonly timeoutMs?: number }): Promise<void>;
  /** Swaps the configuration atomically; the old sinks that are not reused drain and close. */
  reconfigure<const D extends string>(config: LogConfig<D>): Promise<void>;
};

/** A logging instance: the default one behind the global functions, or a private one from `createLogging()`. */
export type Logging = {
  getLogger(category?: string): Logger;
  configure<const C extends string>(config: LogConfig<C>): Configured<C>;
  withContext<R>(fields: Fields, fn: () => R): R;
  shareContext(fields: Fields): void;
};

// ---------------------------------------------------------------------------
// Internals shared with @arki/log/testing
// ---------------------------------------------------------------------------

/** Key of the internal API; `Symbol.for` so two copies of the package share it. */
export const INTERNAL: unique symbol = Symbol.for('@arki/log/internal@1');

/** Receives every record while a fake is installed, with the channel names it was routed to. */
export type Capture = (record: LogRecord, channels: readonly string[]) => void;

export type LoggingInternals = {
  /** Routes every category at `trace` to `capture` instead of the sinks. Returns the restore function. */
  installFake(capture: Capture): () => void;
};

export type InternalLogging = {
  readonly [INTERNAL]: LoggingInternals;
} & Logging;

export function isInternalLogging(value: unknown): value is InternalLogging {
  return typeof value === 'object' && value !== null && INTERNAL in value && 'getLogger' in value;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

type RouteEntry = { readonly sink: Sink; readonly min: number };
type Route = { readonly min: number; readonly entries: readonly RouteEntry[] };

type State = {
  readonly channels: ReadonlyMap<string, Sink>;
  readonly rules: ReadonlyMap<string, CategoryRule<string>>;
  readonly processors: readonly Processor[];
  readonly resource: Fields;
  readonly trace: TraceSource | undefined;
  readonly debugInclude: ReadonlySet<string>;
  readonly debugExclude: ReadonlySet<string>;
};

/** Records at `warn` and up before `configure()` are kept here (RFC §8.3). */
const PRE_CONFIGURE_RING = 64;
const NO_PROCESSORS: readonly Processor[] = [];

function parentOf(category: string): string {
  const index = category.lastIndexOf(':');
  return index === -1 ? '' : category.slice(0, index);
}

class LoggingImpl implements InternalLogging {
  /** Goes up on every configure, reconfigure, close and fake install (RFC §8.2). */
  version = 0;
  processors: readonly Processor[] = NO_PROCESSORS;
  resource: Fields = EMPTY_FIELDS;
  traceSource: TraceSource | undefined;
  shared: Fields | undefined;
  context: ContextStore = syncContext();

  private state: State | undefined;
  private fake: Capture | undefined;
  private ring: LogRecord[] = [];
  private readonly ringRoute: Route;
  private readonly loggers = new Map<string, LoggerImpl>();
  private routes = new Map<string, Route>();

  readonly [INTERNAL]: LoggingInternals = {
    installFake: capture => {
      if (this.fake !== undefined) throw fakeActiveError();
      this.fake = capture;
      this.bump();
      return () => {
        if (this.fake !== capture) return;
        this.fake = undefined;
        this.bump();
      };
    },
  };

  constructor() {
    const ringSink: Sink = {
      write: record => {
        this.ring.push(record);
        if (this.ring.length > PRE_CONFIGURE_RING) this.ring.shift();
      },
    };
    this.ringRoute = { min: Level.warn, entries: [{ sink: ringSink, min: Level.warn }] };
  }

  getLogger(category = ''): Logger {
    return this.loggerFor(category);
  }

  /** The memoised plain logger for a category. */
  loggerFor(category: string): LoggerImpl {
    let logger = this.loggers.get(category);
    if (logger === undefined) {
      logger = new LoggerImpl(this, category, undefined, undefined, undefined);
      this.loggers.set(category, logger);
    }
    return logger;
  }

  configure<const C extends string>(config: LogConfig<C>): Configured<C> {
    if (this.fake !== undefined) throw fakeActiveError();
    if (this.state !== undefined) throw alreadyConfiguredError();
    this.install(config);
    // A handle acts only on the configuration it created. In dev, Vite can
    // close an old module's handle after the reloaded module has configured
    // again; that late close must not shut the new setup down.
    let owned = this.state;
    return {
      flush: () => this.flush(),
      close: options => (this.state === owned ? this.close(options?.timeoutMs) : Promise.resolve()),
      reconfigure: next => {
        if (this.state !== owned) return Promise.reject(staleHandleError());
        const retired = this.install(next);
        owned = this.state;
        return drainAndClose(retired);
      },
    };
  }

  withContext<R>(fields: Fields, fn: () => R): R {
    const outer = this.context.get();
    const scope: Record<string, Value> = {};
    if (outer !== undefined) for (const key in outer) scope[key] = outer[key];
    for (const key in fields) scope[key] = fields[key];
    return this.context.run(scope, fn);
  }

  shareContext(fields: Fields): void {
    const next: Record<string, Value> = {};
    if (this.shared !== undefined) for (const key in this.shared) next[key] = this.shared[key];
    for (const key in fields) next[key] = fields[key];
    this.shared = next;
  }

  /** The route for a category (and an optional `to()` override), cached per version. */
  route(category: string, to?: readonly string[]): Route {
    const key = to === undefined ? category : `${category}\u0000${to.join('\u0000')}`;
    let route = this.routes.get(key);
    if (route === undefined) {
      route = this.resolve(category, to);
      this.routes.set(key, route);
    }
    return route;
  }

  /** Builds one record and sends it down the route (RFC §7). Called only after the level check passed. */
  write(
    logger: LoggerImpl,
    level: number,
    template: string,
    input: FieldInput | undefined,
    explicitError?: Error,
    eventName?: string,
    body?: Value,
  ): void {
    let call: Fields | undefined;
    if (typeof input === 'function') {
      try {
        call = input();
      } catch (error) {
        call = { 'log.thunk_error': error instanceof Error ? error : String(error) };
      }
    } else {
      call = input;
    }
    let error = explicitError;
    if (call !== undefined) {
      const errorKey =
        call.error instanceof Error
          ? 'error'
          : call.err instanceof Error
            ? 'err'
            : call.cause instanceof Error
              ? 'cause'
              : undefined;
      if (errorKey !== undefined) {
        const found = call[errorKey];
        if (error === undefined && found instanceof Error) error = found;
        call = without(call, errorKey);
      }
    }
    const entry = new LogEntry(
      Date.now(),
      level,
      logger.category,
      template,
      this.shared,
      logger.bound,
      this.context.get(),
      call,
      error,
      logger.traceContext ?? this.traceSource?.(),
      this.resource,
      eventName,
      body,
      undefined,
    );
    this.dispatch(entry, logger.entries);
  }

  private dispatch(record: LogRecord, entries: readonly RouteEntry[]): void {
    let current: LogRecord | null = record;
    const processors = this.processors;
    for (const processor of processors) {
      try {
        current = processor(current);
      } catch (error) {
        // Drop the record: the failing processor may be the redactor.
        reportFailure(processor, 'a processor', error);
        return;
      }
      if (current === null) return;
    }
    for (const entry of entries) {
      if (current.level >= entry.min) deliver(entry.sink, current);
    }
  }

  private bump(): void {
    this.version++;
    this.routes = new Map();
  }

  private resolve(category: string, to: readonly string[] | undefined): Route {
    const state = this.state;
    const fake = this.fake;
    if (fake !== undefined) {
      const channels = to ?? (state === undefined ? [] : channelsFor(state, category));
      const sink: Sink = { write: record => fake(record, channels) };
      return { min: Level.trace, entries: [{ sink, min: Level.trace }] };
    }
    if (state === undefined) return this.ringRoute;
    const level = levelFor(state, category);
    const names = to ?? channelsFor(state, category);
    const entries: RouteEntry[] = [];
    let min = Number.POSITIVE_INFINITY;
    for (const name of names) {
      const sink = state.channels.get(name);
      if (sink === undefined) throw unknownChannelError(name, [...state.channels.keys()]);
      if (entries.some(entry => entry.sink === sink)) continue;
      const entryMin =
        sink.captureFrom === undefined
          ? Math.max(level, sink.level === undefined ? 0 : Level[sink.level])
          : Level[sink.captureFrom];
      entries.push({ sink, min: entryMin });
      if (entryMin < min) min = entryMin;
    }
    return { min, entries };
  }

  /** Swaps in a configuration. Returns the old sinks the new one does not reuse, for the caller to drain. */
  private install<C extends string>(config: LogConfig<C>): Sink[] {
    const next = buildState(config);
    const previous = this.state;
    this.state = next;
    this.processors = next.processors;
    this.resource = next.resource;
    this.traceSource = next.trace;
    if (config.context !== undefined) this.context = config.context;
    this.bump();
    if (previous === undefined) {
      const replay = this.ring;
      this.ring = [];
      for (const record of replay) {
        const route = this.route(record.category);
        if (record.level >= route.min) this.dispatch(record, route.entries);
      }
      return [];
    }
    const kept = new Set(next.channels.values());
    return uniqueSinks(previous).filter(sink => !kept.has(sink));
  }

  private async flush(): Promise<void> {
    const state = this.state;
    if (state === undefined) return;
    await Promise.all(uniqueSinks(state).map(async sink => sink.flush?.()));
  }

  private async close(timeoutMs: number | undefined): Promise<void> {
    const state = this.state;
    if (state === undefined) return;
    this.state = undefined;
    this.processors = NO_PROCESSORS;
    this.resource = EMPTY_FIELDS;
    this.traceSource = undefined;
    this.bump();
    const work = drainAndClose(uniqueSinks(state));
    if (timeoutMs === undefined) return work;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>(resolve => {
      timer = setTimeout(resolve, timeoutMs);
    });
    try {
      await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}

function uniqueSinks(state: State): Sink[] {
  return [...new Set(state.channels.values())];
}

async function drainAndClose(sinks: readonly Sink[]): Promise<void> {
  await Promise.all(sinks.map(async sink => sink.flush?.()));
  await Promise.all(sinks.map(async sink => sink.close?.()));
}

function without(fields: Fields, omit: string): Fields {
  const out: Record<string, Value> = {};
  for (const key in fields) if (key !== omit) out[key] = fields[key];
  return out;
}

function buildState<C extends string>(config: LogConfig<C>): State {
  const channels = new Map<string, Sink>(Object.entries<Sink>(config.channels));
  const known = [...channels.keys()];
  const check = (names: readonly string[] | undefined): void => {
    if (names === undefined) return;
    for (const name of names) if (!channels.has(name)) throw unknownChannelError(name, known);
  };
  const env = config.env;
  const rootLevel = env?.level ?? config.default.level;
  toLevel(rootLevel);
  check(config.default.channels);
  const rules = new Map<string, CategoryRule<string>>([['', { level: rootLevel, channels: config.default.channels }]]);
  if (config.categories !== undefined) {
    for (const [category, rule] of Object.entries(config.categories)) {
      if (rule.level !== undefined) toLevel(rule.level);
      check(rule.channels);
      if (category !== '') rules.set(category, rule);
    }
  }
  return {
    channels,
    rules,
    processors: config.processors ?? NO_PROCESSORS,
    resource: config.resource ?? EMPTY_FIELDS,
    trace: config.trace,
    debugInclude: new Set(env?.debug?.include),
    debugExclude: new Set(env?.debug?.exclude),
  };
}

/** Nearest configured ancestor's level, lowered to `debug` by a `DEBUG` match that no `-` exclusion beats. */
function levelFor(state: State, category: string): number {
  let level: number = Level.info;
  for (let name = category; ; name = parentOf(name)) {
    const rule = state.rules.get(name);
    if (rule?.level !== undefined) {
      level = Level[rule.level];
      break;
    }
    if (name === '') break;
  }
  if (state.debugInclude.size === 0) return level;
  for (let name = category; ; name = parentOf(name)) {
    if (state.debugExclude.has(name)) return level;
    if (state.debugInclude.has(name)) return Math.min(level, Level.debug);
    if (name === '') return level;
  }
}

/** Nearest configured ancestor's channels. A rule replaces, it does not add; `inherit: false` stops the walk. */
function channelsFor(state: State, category: string): readonly string[] {
  for (let name = category; ; name = parentOf(name)) {
    const rule = state.rules.get(name);
    if (rule?.channels !== undefined) return rule.channels;
    if (rule?.inherit === false || name === '') return [];
  }
}

class LoggerImpl {
  readonly category: string;
  readonly logging: LoggingImpl;
  readonly bound: BoundFields | undefined;
  readonly traceContext: TraceContext | undefined;
  readonly channels: readonly string[] | undefined;
  /** Late-binding cache (RFC §8.2). */
  version = -1;
  min = Number.POSITIVE_INFINITY;
  entries: readonly RouteEntry[] = [];

  constructor(
    logging: LoggingImpl,
    category: string,
    bound: BoundFields | undefined,
    traceContext: TraceContext | undefined,
    channels: readonly string[] | undefined,
  ) {
    this.logging = logging;
    this.category = category;
    this.bound = bound;
    this.traceContext = traceContext;
    this.channels = channels;
  }

  refresh(): void {
    const route = this.logging.route(this.category, this.channels);
    this.version = this.logging.version;
    this.min = route.min;
    this.entries = route.entries;
  }

  trace(template: string, fields?: FieldInput): void {
    if (this.version !== this.logging.version) this.refresh();
    if (this.min > 1) return;
    this.logging.write(this, 1, template, fields);
  }

  debug(template: string, fields?: FieldInput): void {
    if (this.version !== this.logging.version) this.refresh();
    if (this.min > 5) return;
    this.logging.write(this, 5, template, fields);
  }

  info(template: string, fields?: FieldInput): void {
    if (this.version !== this.logging.version) this.refresh();
    if (this.min > 9) return;
    this.logging.write(this, 9, template, fields);
  }

  warn(template: string, fields?: FieldInput): void {
    if (this.version !== this.logging.version) this.refresh();
    if (this.min > 13) return;
    this.logging.write(this, 13, template, fields);
  }

  error(template: string | Error, fields?: FieldInput): void {
    if (this.version !== this.logging.version) this.refresh();
    if (this.min > 17) return;
    if (typeof template === 'string') this.logging.write(this, 17, template, fields);
    else this.logging.write(this, 17, template.message, fields, template);
  }

  fatal(template: string | Error, fields?: FieldInput): void {
    if (this.version !== this.logging.version) this.refresh();
    if (this.min > 21) return;
    if (typeof template === 'string') this.logging.write(this, 21, template, fields);
    else this.logging.write(this, 21, template.message, fields, template);
  }

  log(level: LevelInput, template: string, fields?: FieldInput): void {
    const severity = toLevel(level);
    if (this.version !== this.logging.version) this.refresh();
    if (this.min > severity) return;
    this.logging.write(this, severity, template, fields);
  }

  isEnabled(level: LevelInput): boolean {
    const severity = toLevel(level);
    if (this.version !== this.logging.version) this.refresh();
    return severity >= this.min;
  }

  emit(event: LogEvent): void {
    const severity = toLevel(event.level);
    if (this.version !== this.logging.version) this.refresh();
    if (this.min > severity) return;
    this.logging.write(this, severity, '', event.fields, undefined, event.eventName, event.body);
  }

  with(fields: Fields): LoggerImpl {
    const merged: Record<string, Value> = {};
    const previous = this.bound?.fields;
    if (previous !== undefined) for (const key in previous) merged[key] = previous[key];
    for (const key in fields) merged[key] = fields[key];
    return new LoggerImpl(
      this.logging,
      this.category,
      { fields: merged, json: undefined },
      this.traceContext,
      this.channels,
    );
  }

  child(name: string): LoggerImpl {
    const category = this.category === '' ? name : `${this.category}:${name}`;
    if (this.bound === undefined && this.traceContext === undefined && this.channels === undefined) {
      return this.logging.loggerFor(category);
    }
    return new LoggerImpl(this.logging, category, this.bound, this.traceContext, this.channels);
  }

  withTrace(trace: TraceContext): LoggerImpl {
    return new LoggerImpl(this.logging, this.category, this.bound, trace, this.channels);
  }

  to(...channels: readonly string[]): LoggerImpl {
    return new LoggerImpl(this.logging, this.category, this.bound, this.traceContext, channels);
  }
}

/** A private logging instance with the same functions as the default one (RFC §8.1). */
export function createLogging(): Logging {
  return new LoggingImpl();
}

/** For the default instance: same as `createLogging`, typed with the internal API. */
export function createInternalLogging(): InternalLogging {
  return new LoggingImpl();
}
