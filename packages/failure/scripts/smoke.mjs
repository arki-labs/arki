// Cross-runtime smoke test. Runs the BUILT package (dist/) under Node, Bun and
// Deno via `bun run test:runtimes`, and is bundled for the browser and Hermes
// targets. One call per feature; the unit tests cover the details. The `/eslint`
// entry needs its peers, so the unit tests cover it; `/orpc` gets one check of
// `orThrowRpc`, with plain errors standing in for the handler's.

import {
  attempt,
  collect,
  defineFailure,
  FailureError,
  findCause,
  InvalidInput,
  invariant,
  isFailure,
  match,
  orThrow,
  partition,
  recover,
  revive,
  serialize,
  stoppable,
  UnexpectedFailure,
  unreachable,
  ValidatorDefect,
} from '../dist/index.js';
import { orThrowRpc } from '../dist/orpc.js';
import { parse, parseAsync } from '../dist/schema.js';

/** A minimal Standard Schema object, so the smoke test needs no validator library. */
function idSchema() {
  return {
    '~standard': {
      version: 1,
      vendor: 'smoke',
      validate: value =>
        typeof value === 'object' && value !== null && typeof value.id === 'number'
          ? { value }
          : { issues: [{ message: 'id must be a number' }] },
    },
  };
}

async function main() {
  const NotFound = defineFailure('item.not_found', { status: 404, message: 'no item {id}', data: idSchema() });
  const Timeout = defineFailure('db.timeout', { status: 503 });
  const find = async id => (id === 1 ? { id, name: 'one' } : NotFound({ id }));
  const findSync = id => (id === 1 ? { id, name: 'one' } : NotFound({ id }));

  const found = await find(1);
  const missing = await find(2);
  const thrown = await orThrow(find(2)).then(
    () => 'resolved',
    error => (error instanceof UnexpectedFailure ? error.code : error.name),
  );
  let unreachableCode = 'not thrown';
  try {
    unreachable('x');
  } catch (error) {
    unreachableCode = error instanceof FailureError ? error.code : error.name;
  }
  // Early return is plain code: each returned failure joins the inferred result.
  const both = (a, b) => {
    const item = findSync(a);
    if (isFailure(item)) return item;
    const other = findSync(b);
    if (isFailure(other)) return other;
    return item.name + other.name;
  };
  const stepped = both(1, 3);
  const parsed = attempt(
    () => JSON.parse('{'),
    () => 'fallback',
  );
  const json = JSON.stringify(NotFound({ id: 7 }));
  const revived = revive(JSON.parse(json), [NotFound, Timeout]);
  const [ok, failed] = partition([findSync(1), findSync(2)]);
  const chain = NotFound({ id: 9 }, { cause: Timeout() });
  // The handler's `errors`: one constructor per declared code.
  const rpcErrors = { 'item.not_found': ({ message }) => new Error(message) };
  const answered = orThrowRpc(undefined, rpcErrors, 'success');
  const rpcThrown = await orThrowRpc(find(2), rpcErrors, 'success').then(
    () => 'resolved',
    error => error.message,
  );

  const stopped = stoppable({ delivered: 2 }, Timeout());
  const finished = stoppable({ delivered: 3 });

  const checks = [
    ['schema returns output', parse(idSchema(), { id: 1 }).id, 1],
    ['schema returns invalid input', InvalidInput.is(parse(idSchema(), false)), true],
    ['async schema returns output', (await parseAsync(idSchema(), { id: 2 })).id, 2],
    [
      'validator defects are typed',
      ValidatorDefect.is(
        parse(
          {
            get '~standard'() {
              throw new Error('private');
            },
          },
          null,
        ),
      ),
      true,
    ],
    ['versioned wire envelope', serialize(NotFound({ id: 3 }), [NotFound]).version, 1],
    ['success is the plain value', isFailure(found) ? 'failure' : found.name, 'one'],
    ['failure is recognised', isFailure(missing) && missing.code, 'item.not_found'],
    ['message template', missing.message, 'no item 2'],
    ['failure status', missing.status, 404],
    ['brand hidden from JSON', JSON.stringify(Timeout()).includes('~failure'), false],
    [
      'match picks the branch',
      match(missing, { ok: () => 'ok', 'item.not_found': f => `missing ${f.data.id}` }),
      'missing 2',
    ],
    ['recover narrows', recover(missing, { 'item.not_found': () => 'default' }), 'default'],
    ['orThrow on a promise', thrown, 'item.not_found'],
    [
      'invariant is coded',
      (() => {
        try {
          invariant(false);
        } catch (error) {
          return error instanceof FailureError ? error.code : error.name;
        }
        return 'not thrown';
      })(),
      'ARKI_FAILURE_E008',
    ],
    ['unreachable is coded', unreachableCode, 'ARKI_FAILURE_E004'],
    ['early return gives the first failure', isFailure(stepped) && stepped.data.id, 3],
    ['attempt maps a throw', parsed, 'fallback'],
    ['revive restores the brand', isFailure(revived) && revived.message, 'no item 7'],
    ['partition splits', `${ok.length}:${failed.length}`, '1:1'],
    ['collect returns the first failure', collect([findSync(1), findSync(4)]).code, 'item.not_found'],
    ['findCause walks the chain', findCause(chain, Timeout)?.code, 'db.timeout'],
    ['orThrowRpc answers success for nothing', answered, 'success'],
    ['orThrowRpc still throws the failure', rpcThrown, 'no item 2'],
    ['stoppable keeps the value and the failure', `${stopped.delivered} ${stopped.stoppedBy.code}`, '2 db.timeout'],
    ['stoppable adds no stoppedBy key when finished', Object.keys(finished).join(','), 'delivered'],
  ];

  let failedChecks = 0;
  for (const [name, actual, expected] of checks) {
    if (actual === expected) continue;
    failedChecks++;
    console.log(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  const runtime =
    typeof HermesInternal !== 'undefined'
      ? 'hermes'
      : typeof Deno !== 'undefined'
        ? 'deno'
        : typeof Bun !== 'undefined'
          ? 'bun'
          : typeof window !== 'undefined'
            ? 'browser'
            : 'node';
  if (failedChecks > 0) {
    console.log(`${runtime}: ${failedChecks} smoke checks FAILED`);
    throw new Error('smoke failed');
  }
  console.log(`${runtime}: ${checks.length} smoke checks passed`);
}

main();
