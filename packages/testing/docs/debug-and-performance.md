# Debug and performance

## Debug

Debug output is off. Turn it on with `DEBUG_TESTS=true vitest`, or in code.

```ts run
import { configureDebug, createDebugContext, isDebugEnabled, logSection, logState, timeOperation } from '@arki/testing';

configureDebug({ enabled: true });

logSection('Setup');
logState('User', { id: 'usr_ada' });
const timer = timeOperation('Create 100 users');
timer.end();

const debug = createDebugContext('UserTests');
debug.log('Creating user');

console.log(isDebugEnabled());
```

```text
true
```

`logDebug(message, ...args)` and `logQuery(sql, params)` write one line each. `dumpDatabase(db)` and `dumpTable(db, 'users', 10)` print rows from a live Drizzle database, so they need one:

```ts skip="needs a live Drizzle database"
import { dumpDatabase, dumpTable } from '@arki/testing';

await dumpDatabase(tester.db);
await dumpTable(tester.db, 'users', 10);
```

## Performance

Each helper times an async operation. A `maxMs` budget makes it throw when the operation is slower.

```ts run
import { assertPerformance, comparePerformance, createPerformanceTracker, measurePerformance } from '@arki/testing';

const work = async () => 21 * 2;

await measurePerformance('Compute', work, { maxMs: 1000 });
const answer = await assertPerformance('Compute', work, 1000);
await comparePerformance({ 'Method A': work, 'Method B': work }, 5);

const tracker = createPerformanceTracker();
await tracker.measure('Setup', work);
await tracker.measure('Main', work, { maxMs: 500 });

console.log(answer);
```

```text
42
```

`benchmarkQuery(label, fn, iterations)` returns average, minimum, maximum and the 50th, 95th and 99th percentiles. `tracker.printSummary()` prints every measured step. `measureQuery` times one Drizzle query.
