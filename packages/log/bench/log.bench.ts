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
const fromFlat = (messageKey: string) => (line: string) => {
  const o = record(line);
  return text({ message: o[messageKey], fields: pick(o) });
};
const fromConsola = (line: string): string => {
  const o = record(line);
  const [message, fields] = o.args as [unknown, Record<string, unknown>];
  return text({ message, fields: pick(fields) });
};

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
  ],
});
