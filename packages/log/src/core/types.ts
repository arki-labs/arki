import type { LevelName } from './levels.js';

/** A field value (RFC §5.2). */
export type Value =
  | string
  | number
  | boolean
  | null
  | undefined
  | bigint
  | Date
  | Error
  | readonly Value[]
  | { readonly [key: string]: Value };

/** One field map per record, as in OpenTelemetry. */
export type Fields = Readonly<Record<string, Value>>;

/** Fields, or a synchronous thunk that builds them only when the level is enabled (RFC §5.4). */
export type FieldInput = Fields | (() => Fields);

/** A trace context stamped on a record. */
export type TraceContext = {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags?: number;
};

/** Reads the active trace when a record is built (`@arki/log/otel` provides one). */
export type TraceSource = () => TraceContext | undefined;

/** The record handed to processors, sinks and formatters (RFC §5.6). */
export type LogRecord = Readonly<{
  /** Epoch milliseconds. */
  time: number;
  /** 1..24 (OTel SeverityNumber). */
  level: number;
  /** OTel SeverityText. */
  levelName: LevelName;
  category: string;
  /** `''` for `emit()`. */
  template: string;
  eventName?: string;
  body?: Value;
  fields: Fields;
  error?: Error;
  traceId?: string;
  spanId?: string;
  traceFlags?: number;
  resource: Fields;
  /** Renders the template on first call, then memoised. */
  message(): string;
}>;

/** Returns the record (or a changed copy from `updateRecord`), or `null` to drop it. */
export type Processor = (record: LogRecord) => LogRecord | null;

/** Turns a record into one line of text. */
export type Formatter = (record: LogRecord) => string;

/** An output (RFC §7). `write` is synchronous; a sink that does async IO buffers inside itself. */
export type Sink = {
  write(record: LogRecord): void;
  flush?(): void | Promise<void>;
  close?(): void | Promise<void>;
  /** The sink's own floor. */
  level?: LevelName;
  /** The sink's own processors, run after the global ones. */
  processors?: readonly Processor[];
  /**
   * Records from this level up reach this sink even when the category's level is higher.
   * Set by `fingersCrossed`; it never lowers other sinks' levels.
   */
  captureFrom?: LevelName;
};

/** Where scoped context (`withContext`) lives. The core ships a synchronous store; `@arki/log/node` ships `asyncContext()`. */
export type ContextStore = {
  get(): Fields | undefined;
  run<R>(fields: Fields, fn: () => R): R;
};

/** Settings read from the environment by `fromEnv()` in `@arki/log/node` (RFC §8.5). */
export type EnvSettings = {
  /** `LOG_LEVEL`: replaces `default.level`. */
  readonly level?: LevelName;
  /** `DEBUG`: categories lowered to `debug`, and categories excluded with `-`. `''` is the root. */
  readonly debug?: { readonly include: readonly string[]; readonly exclude: readonly string[] };
  /** `NO_COLOR`: `false` when set. Pass it to `pretty({ colors })`; formatters do not read config. */
  readonly colors?: boolean;
};

/** A rule for one category and its descendants (RFC §8.1). */
export type CategoryRule<C extends string> = {
  readonly level?: LevelName;
  readonly channels?: readonly C[];
  /** `false`: start from no channels instead of the parent's. */
  readonly inherit?: boolean;
};

/** The argument of `configure()` (RFC §8.1). */
export type LogConfig<C extends string> = {
  readonly channels: Readonly<Record<C, Sink>>;
  readonly default: { readonly level: LevelName; readonly channels: readonly NoInfer<C>[] };
  readonly categories?: Readonly<Record<string, CategoryRule<NoInfer<C>>>>;
  readonly processors?: readonly Processor[];
  readonly resource?: Fields;
  readonly context?: ContextStore;
  readonly trace?: TraceSource;
  readonly env?: EnvSettings;
};
