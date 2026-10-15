// Cross-runtime smoke test. Runs the BUILT package (dist/) under Node, Bun and
// Deno via `bun run test:runtimes`, and is bundled for the browser and Hermes
// targets. One call per feature; the unit tests cover the details. The `/orpc`
// and `/eslint` entries need their peers, so the unit tests cover them.

import {
  assertNever,
  attempt,
  collect,
  defineFailure,
  FailureError,
  findCause,
  isFailure,
  match,
  orThrow,
  partition,
  recover,
  revive,
  UnexpectedFailure,
} from '../dist/index.js';

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
  let unreachable = 'not thrown';
  try {
    assertNever('x');
  } catch (error) {
    unreachable = error instanceof FailureError ? error.code : error.name;
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

  const checks = [
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
    ['assertNever is coded', unreachable, 'ARKI_FAILURE_E004'],
    ['early return gives the first failure', isFailure(stepped) && stepped.data.id, 3],
    ['attempt maps a throw', parsed, 'fallback'],
    ['revive restores the brand', isFailure(revived) && revived.message, 'no item 7'],
    ['partition splits', `${ok.length}:${failed.length}`, '1:1'],
    ['collect returns the first failure', collect([findSync(1), findSync(4)]).code, 'item.not_found'],
    ['findCause walks the chain', findCause(chain, Timeout)?.code, 'db.timeout'],
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
