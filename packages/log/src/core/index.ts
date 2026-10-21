/** The core of `@arki/log`: loggers, `configure()`, templates, processors, formatters, core sinks and wrappers. */
// @arki/log core: zero dependencies, web-standard globals only. Importing does nothing.

export { configure, getLogger, shareContext, withContext } from './default.js';
export { LOG_ERROR_CODES, LogError, type LogErrorCode } from './errors.js';
export { json, logfmt, pretty } from './formatters.js';
export { Level, type LevelInput, type LevelName } from './levels.js';
export {
  type ChannelName,
  type ConfigureOptions,
  type Configured,
  createLogging,
  type LogEvent,
  type Logger,
  type Logging,
  type Register,
} from './logging.js';
export { type Censor, dropWhen, enrich, maskSecrets, MIN_SECRET_LENGTH, redact } from './processors.js';
export { type RecordChanges, updateRecord } from './record.js';
export { serializeError, serializeFailure } from './serialize.js';
export { consoleSink, lineSink, type MemorySink, memorySink } from './sinks.js';
export { type FieldsArg, type PlaceholderNames, renderTemplate } from './template.js';
export type {
  CategoryRule,
  ContextStore,
  EnvSettings,
  FailureLike,
  FieldInput,
  Fields,
  Formatter,
  LogConfig,
  LogRecord,
  Processor,
  Sink,
  TraceContext,
  TraceSource,
  Value,
} from './types.js';
export { buffer, deduplicate, fingersCrossed } from './wrappers.js';
