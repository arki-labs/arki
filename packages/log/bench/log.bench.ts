// Speed of @arki/log against pino (which it wraps), winston and consola.
// Run: `bun run bench` (explore) or `bun run bench --profile publish --write-readme`.
//
// Every logger writes to an in-process sink, so nothing touches a terminal or a disk.
// The JSON shapes differ between libraries, so the contract is narrow: one line that
// contains the message and the three fields. Each case parses its own line to check it.

import { Writable } from 'node:stream';
import { createConsola } from 'consola';
import pino from 'pino';
import winston from 'winston';

import { compare, defineSuite, scenario } from '@arki/bench';
import { configuration, Logger } from '@arki/log';
import { createLogging, fingersCrossed, lineSink, redact } from '@arki/log/core';
import { file } from '@arki/log/node';

type Fields = { userId: number; route: string; cached: boolean };
type Call = { message: string; fields: Fields };

// One sink for every logger: counts the lines written and keeps the last one.
const sink = {
  count: 0,
  last: '',
  write(chunk: string): boolean {
    sink.count += 1;
    sink.last = chunk;
    return true;
  },
};
// winston's Stream transport needs a real Writable.
const sinkStream = new Writable({
  write(chunk: Buffer | string, _encoding, done) {
    sink.write(String(chunk));
    done();
  },
});

// @arki/log builds its own pino instance at import time and writes it to stdout. Swap it for an
// equivalent one (same options) that writes to the sink. Batching is off by default and stays off.
configuration.transport = pino({ level: 'trace', base: null, timestamp: false }, sink);
const arki = new Logger('bench');
arki.setSeverity(configuration.getSeverity()); // INFO unless LOG_LEVEL says otherwise

const pinoLog = pino({ level: 'info', base: null }, sink);

// The new zero-dependency core (`@arki/log/core`), writing JSON lines to the same sink.
const coreLogging = createLogging();
coreLogging.configure({
  channels: { sink: lineSink(line => sink.write(line)) },
  default: { level: 'info', channels: ['sink'] },
});
const core = coreLogging.getLogger('bench');
const coreBound = core.with({ requestId: 'r-1' });
const pinoBound = pinoLog.child({ requestId: 'r-1' });

// Redaction of five paths, in the core and in pino.
const secretPaths = ['password', 'token', 'apiKey', 'headers.authorization', 'card.number'];
const coreRedactLogging = createLogging();
coreRedactLogging.configure({
  channels: { sink: lineSink(line => sink.write(line)) },
  default: { level: 'info', channels: ['sink'] },
  processors: [redact(secretPaths)],
});
const coreRedact = coreRedactLogging.getLogger('bench');
const pinoRedact = pino({ level: 'info', base: null, redact: { paths: secretPaths, censor: '[REDACTED]' } }, sink);

// Fingers-crossed with no trigger: info records are held in the ring, nothing is written.
const coreHeldLogging = createLogging();
coreHeldLogging.configure({
  channels: {
    held: fingersCrossed(
      lineSink(line => sink.write(line)),
      { scope: 'global' },
    ),
  },
  default: { level: 'info', channels: ['held'] },
});
const coreHeld = coreHeldLogging.getLogger('bench');

// Real writes to /dev/null: the core's buffered file sink against pino.destination (sync, 16 KiB buffer).
const coreDevNullLogging = createLogging();
coreDevNullLogging.configure({
  channels: { devnull: file({ path: '/dev/null' }) },
  default: { level: 'info', channels: ['devnull'] },
});
const coreDevNull = coreDevNullLogging.getLogger('bench');
const pinoDevNull = pino({ level: 'info', base: null }, pino.destination({ dest: '/dev/null', minLength: 16 * 1024 - 1 }));

const winstonLog = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Stream({ stream: sinkStream })],
});

const consolaLog = createConsola({
  level: 3, // info
  reporters: [
    {
      log: logObj => {
        sink.write(JSON.stringify({ level: logObj.level, type: logObj.type, time: Date.now(), args: logObj.args }));
      },
    },
  ],
});

// Varied messages and fields, including characters JSON must escape and non-ASCII text.
const calls: readonly Call[] = [
  { message: 'order created', fields: { userId: 42, route: '/orders', cached: true } },
  { message: 'comandă creată ✓', fields: { userId: 0, route: '/comenzi/ăîșț', cached: false } },
  { message: 'said "hi"\nthen left', fields: { userId: 9_007_199_254, route: '/a\\b?x=1&y="2"', cached: true } },
  { message: 'x'.repeat(200), fields: { userId: -1, route: '/', cached: false } },
];

type Parsed = { message: unknown; fields: unknown };
const record = (line: string): Record<string, unknown> => JSON.parse(line) as Record<string, unknown>;
const pick = (o: Record<string, unknown>): Parsed['fields'] => ({
  userId: o.userId,
  route: o.route,
  cached: o.cached,
});
const text = (value: Parsed): string => JSON.stringify(value);

// How each library lays out the message and the fields in its line.
const fromArki = (line: string): string => {
  const o = record(line);
  return text({ message: o.body, fields: pick(o.attributes as Record<string, unknown>) });
};
const fromCore = (line: string): string => {
  const o = record(line);
  return text({ message: o.message, fields: pick(o.fields as Record<string, unknown>) });
};
const fromFlat = (messageKey: string) => (line: string) => {
  const o = record(line);
  return text({ message: o[messageKey], fields: pick(o) });
};
const fromConsola = (line: string): string => {
  const o = record(line);
  const [message, fields] = o.args as [unknown, Record<string, unknown>];
  return text({ message, fields: pick(fields) });
};

// Five secrets, by the paths `secretPaths` names.
const secrets = {
  password: 'hunter2',
  token: 'tok-123',
  apiKey: 'key-456',
  headers: { authorization: 'Bearer s3cret', accept: 'json' },
  card: { number: '4111111111111111', brand: 'visa' },
};
const redactedSecrets = {
  password: '[REDACTED]',
  token: '[REDACTED]',
  apiKey: '[REDACTED]',
  authorization: '[REDACTED]',
  number: '[REDACTED]',
};
const pickSecrets = (o: Record<string, unknown>): Record<string, unknown> => ({
  password: o.password,
  token: o.token,
  apiKey: o.apiKey,
  authorization: (o.headers as Record<string, unknown>).authorization,
  number: (o.card as Record<string, unknown>).number,
});

const noLine = (call: Call, write: (call: Call) => void): number => {
  const before = sink.count;
  write(call);
  return sink.count - before;
};

export default defineSuite({
  id: '@arki/log',
  intro:
    'Logging a line to an in-process sink with `@arki/log`, against pino (which it wraps), winston and consola. Pino is the speed reference for structured JSON logging in Node; winston and consola are the other widely used loggers.',
  notes: [
    'Every logger writes to a sink in memory. `@arki/log` builds its own pino instance that writes to stdout, so the benchmark swaps `configuration.transport` for an identical pino instance (same options) that writes to the sink. Batching is off, which is the default.',
    "The JSON differs. `@arki/log` wraps each call in a record (name, body, attributes, severity number and text, timestamp, trace ids) before handing it to pino. That is the structured contract the package sells, and it is the extra work in the rows below. Direct pino, winston and consola write only the message and the fields. The contract is therefore narrow: one line that contains the message and the three fields with the same values, and the check parses each library's line to read them back.",
    '`@arki/log/core` is the zero-dependency rewrite (plan 007). It writes one JSON object per line: `time`, `level`, `levelName`, `category`, `template`, the rendered `message`, then `fields`. Its rows use the same sink and the same contract.',
    'Pino is used the way its docs show (fields first, then the message), with `base: null` to match `@arki/log`. Winston has the timestamp and JSON formats on. Consola has one reporter that writes `JSON.stringify` of the entry (level, type, time, arguments). winston writes through a stream, so its cost includes that.',
  ],
  groups: [
    compare<Call>({
      id: 'info-fields',
      title: 'info: message + 3 fields',
      contract: {
        id: 'log-info-line/v1',
        description: 'one written line that contains the message and the 3 fields with the same values',
      },
      inputs: calls,
      expected: ({ message, fields }) => text({ message, fields }),
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/log logger.info(msg, fields)',
          package: '@arki/log',
          run: ({ message, fields }) => {
            arki.info(message, fields);
            return sink.last;
          },
          normalize: fromArki,
        }),
        core: c({
          label: '@arki/log/core log.info(msg, fields)',
          package: '@arki/log',
          run: ({ message, fields }) => {
            core.info(message, fields);
            return sink.last;
          },
          normalize: fromCore,
        }),
        pino: c({
          label: 'pino log.info(fields, msg) (used directly)',
          package: 'pino',
          run: ({ message, fields }) => {
            pinoLog.info(fields, message);
            return sink.last;
          },
          normalize: fromFlat('msg'),
        }),
        winston: c({
          label: 'winston log.info(msg, fields)',
          package: 'winston',
          run: ({ message, fields }) => {
            winstonLog.info(message, fields);
            return sink.last;
          },
          normalize: fromFlat('message'),
        }),
        consola: c({
          label: 'consola log.info(msg, fields)',
          package: 'consola',
          run: ({ message, fields }) => {
            consolaLog.info(message, fields);
            return sink.last;
          },
          normalize: fromConsola,
        }),
      }),
    }),
    compare<Call>({
      id: 'disabled',
      title: 'debug call while the level is info (disabled)',
      note: 'The call is dropped before anything is built. This is the cost of leaving debug logging in hot code. The result is the number of lines written by the call.',
      contract: { id: 'log-disabled/v1', description: 'no written line from a debug call below the active info level' },
      inputs: calls,
      expected: () => 0,
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/log logger.debug(msg, fields)',
          package: '@arki/log',
          run: call => noLine(call, ({ message, fields }) => arki.debug(message, fields)),
        }),
        core: c({
          label: '@arki/log/core log.debug(msg, fields)',
          package: '@arki/log',
          run: call => noLine(call, ({ message, fields }) => core.debug(message, fields)),
        }),
        pino: c({
          label: 'pino log.debug(fields, msg) (used directly)',
          package: 'pino',
          run: call => noLine(call, ({ message, fields }) => pinoLog.debug(fields, message)),
        }),
        winston: c({
          label: 'winston log.debug(msg, fields)',
          package: 'winston',
          run: call => noLine(call, ({ message, fields }) => winstonLog.debug(message, fields)),
        }),
        consola: c({
          label: 'consola log.debug(msg, fields)',
          package: 'consola',
          run: call => noLine(call, ({ message, fields }) => consolaLog.debug(message, fields)),
        }),
      }),
    }),
    scenario({
      kind: 'scenario',
      id: 'child',
      title: 'Create a child logger with one bound field',
      note: 'The usual per-request or per-module pattern. The rows do different work and are not ranked: consola has no bound fields, so its row uses `withTag` (a name only).',
      cases: {
        arki: {
          label: '@arki/log logger.child(name, fields)',
          package: '@arki/log',
          run: () => arki.child('http', { requestId: 'r-1' }),
        },
        core: {
          label: '@arki/log/core log.with(fields)',
          package: '@arki/log',
          run: () => core.with({ requestId: 'r-1' }),
        },
        pino: {
          label: 'pino log.child(bindings) (used directly)',
          package: 'pino',
          run: () => pinoLog.child({ name: 'http', requestId: 'r-1' }),
        },
        winston: {
          label: 'winston log.child(meta)',
          package: 'winston',
          run: () => winstonLog.child({ name: 'http', requestId: 'r-1' }),
        },
        consola: { label: 'consola log.withTag(name)', package: 'consola', run: () => consolaLog.withTag('http') },
      },
    }),
    compare<Call>({
      id: 'message-only',
      title: 'info: message only',
      contract: { id: 'log-message-line/v1', description: 'one written line that contains the message' },
      inputs: calls,
      expected: ({ message }) => message,
      baseline: 'core',
      cases: c => ({
        core: c({
          label: '@arki/log/core log.info(msg)',
          package: '@arki/log',
          run: ({ message }) => {
            core.info(message);
            return sink.last;
          },
          normalize: line => record(line).message,
        }),
        pino: c({
          label: 'pino log.info(msg)',
          package: 'pino',
          run: ({ message }) => {
            pinoLog.info(message);
            return sink.last;
          },
          normalize: line => record(line).msg,
        }),
        winston: c({
          label: 'winston log.info(msg)',
          package: 'winston',
          run: ({ message }) => {
            winstonLog.info(message);
            return sink.last;
          },
          normalize: line => record(line).message,
        }),
        consola: c({
          label: 'consola log.info(msg)',
          package: 'consola',
          run: ({ message }) => {
            consolaLog.info(message);
            return sink.last;
          },
          normalize: line => (record(line).args as unknown[])[0],
        }),
      }),
    }),
    compare<Call>({
      id: 'bound-fields',
      title: 'info: message + 3 fields on a logger with 1 bound field',
      contract: {
        id: 'log-bound-line/v1',
        description: 'one written line with the message, the 3 call fields and the bound requestId',
      },
      inputs: calls,
      expected: ({ message, fields }) => text({ message, fields: { ...fields, requestId: 'r-1' } }),
      baseline: 'core',
      cases: c => ({
        core: c({
          label: '@arki/log/core log.with(bound).info(msg, fields)',
          package: '@arki/log',
          run: ({ message, fields }) => {
            coreBound.info(message, fields);
            return sink.last;
          },
          normalize: line => {
            const o = record(line);
            const f = o.fields as Record<string, unknown>;
            return text({ message: o.message, fields: { ...pick(f), requestId: f.requestId } });
          },
        }),
        pino: c({
          label: 'pino log.child(bound).info(fields, msg)',
          package: 'pino',
          run: ({ message, fields }) => {
            pinoBound.info(fields, message);
            return sink.last;
          },
          normalize: line => {
            const o = record(line);
            return text({ message: o.msg, fields: { ...pick(o), requestId: o.requestId } });
          },
        }),
      }),
    }),
    compare<Call>({
      id: 'template-render',
      title: 'info: a message built from 2 values',
      note: 'The core renders a `{placeholder}` template from its fields; pino formats printf-style `%d` / `%s` arguments.',
      contract: {
        id: 'log-rendered-message/v1',
        description: 'one written line whose message is "user <userId> on <route>"',
      },
      inputs: calls,
      expected: ({ fields }) => `user ${String(fields.userId)} on ${fields.route}`,
      baseline: 'core',
      cases: c => ({
        core: c({
          label: "@arki/log/core log.info('user {userId} on {route}', fields)",
          package: '@arki/log',
          run: ({ fields }) => {
            core.info('user {userId} on {route}', fields);
            return sink.last;
          },
          normalize: line => record(line).message,
        }),
        pino: c({
          label: "pino log.info('user %d on %s', userId, route)",
          package: 'pino',
          run: ({ fields }) => {
            pinoLog.info('user %d on %s', fields.userId, fields.route);
            return sink.last;
          },
          normalize: line => record(line).msg,
        }),
      }),
    }),
    compare<Call>({
      id: 'redact',
      title: 'info: message + 5 secret fields, all redacted',
      contract: {
        id: 'log-redacted-line/v1',
        description: 'one written line with the message and the 5 secret paths replaced by "[REDACTED]"',
      },
      inputs: calls,
      expected: ({ message }) => text({ message, fields: redactedSecrets }),
      baseline: 'core',
      cases: c => ({
        core: c({
          label: '@arki/log/core redact([5 paths])',
          package: '@arki/log',
          run: ({ message }) => {
            coreRedact.info(message, secrets);
            return sink.last;
          },
          normalize: line => {
            const o = record(line);
            return text({ message: o.message, fields: pickSecrets(o.fields as Record<string, unknown>) });
          },
        }),
        pino: c({
          label: 'pino redact: { paths: [5 paths] }',
          package: 'pino',
          run: ({ message }) => {
            pinoRedact.info(secrets, message);
            return sink.last;
          },
          normalize: line => {
            const o = record(line);
            return text({ message: o.msg, fields: pickSecrets(o) });
          },
        }),
      }),
    }),
    scenario({
      kind: 'scenario',
      id: 'fingers-crossed',
      title: 'info: message + 3 fields held by fingersCrossed (no trigger)',
      note: 'Records wait in a bounded ring for an error that never comes, so nothing is written. Pino has no equivalent; the plain core row is the same call with a normal sink.',
      inputs: calls,
      cases: {
        held: {
          label: '@arki/log/core fingersCrossed, no trigger',
          package: '@arki/log',
          run: ({ message, fields }) => coreHeld.info(message, fields),
        },
        written: {
          label: '@arki/log/core plain sink',
          package: '@arki/log',
          run: ({ message, fields }) => core.info(message, fields),
        },
      },
    }),
    scenario({
      kind: 'scenario',
      id: 'dev-null',
      title: 'info: message + 3 fields, really written to /dev/null',
      note: 'Both buffer lines and write them with `fs.writeSync` at 16 KiB: the core `file()` sink and `pino.destination({ minLength: 16 KiB })`. Not ranked: the line layouts differ.',
      inputs: calls,
      cases: {
        core: {
          label: "@arki/log/core file({ path: '/dev/null' })",
          package: '@arki/log',
          run: ({ message, fields }) => coreDevNull.info(message, fields),
        },
        pino: {
          label: "pino.destination({ dest: '/dev/null', minLength: 16383 })",
          package: 'pino',
          run: ({ message, fields }) => pinoDevNull.info(fields, message),
        },
      },
    }),
  ],
});
