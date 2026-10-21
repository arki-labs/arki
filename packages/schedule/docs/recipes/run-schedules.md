# Run schedules

Define a schedule, start the runtime, run the schedule once by hand, and see what a second run at the same moment does.

A schedule has a `name`, a timing (`cron` or `every`) and a `handler`. `createScheduleRuntime` from `@arki/schedule/runtime` runs them without Dot. `start()` arms the timers. `trigger(name)` runs one now and returns its `ScheduleRunResult`. `stop()` waits for active runs.

The schedule below sets `overlap: 'skip'`. While one run is active in this process, a second run is `skipped-overlap` and the handler does not start. Without it, both would run.

```ts from="examples/run-schedules.ts#run"
import { defineSchedule } from '@arki/schedule';
import { createScheduleRuntime } from '@arki/schedule/runtime';

const report = defineSchedule({
  name: 'daily-report',
  every: '1h',
  overlap: 'skip',
  handler: async () => {
    await new Promise(resolve => setTimeout(resolve, 50));
    return { rows: 3 };
  },
});

const runtime = createScheduleRuntime({ schedules: [report] });
runtime.start(); // arms the timer: the first tick is an hour away

// Run it now, as a test or an admin button would.
const first = runtime.trigger('daily-report');
const second = runtime.trigger('daily-report'); // the first run is still active in this process

for (const result of await Promise.all([first, second])) {
  console.log(result.status === 'ran' ? `ran: ${result.value.rows} rows` : result.status);
}

await runtime.stop();
```

Overlap is checked per process. For several replicas, give a feature schedule a `lock`. See [Schedules in a Dot app](../reference/dot.md#one-replica-at-a-time-lock).

Run it from `packages/schedule`:

```sh
bun examples/run-schedules.ts
```

Expected output:

```text
ran: 3 rows
skipped-overlap
```
