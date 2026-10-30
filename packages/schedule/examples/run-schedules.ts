// #region run
import { orThrow } from '@arki/failure';
import { defineSchedule } from '@arki/schedule';
import { createScheduleRuntime } from '@arki/schedule/runtime';

const doughProof = defineSchedule({
  name: 'nightly-dough-proof',
  every: '1h',
  overlap: 'skip',
  handler: async () => {
    await new Promise(resolve => setTimeout(resolve, 50));
    return { rows: 3 };
  },
});

const runtime = createScheduleRuntime({ schedules: [doughProof] });
orThrow(await runtime.start()); // arms the timer: the first tick is an hour away

// Run it now, as a test or an admin button would.
const first = runtime.trigger('nightly-dough-proof');
const second = runtime.trigger('nightly-dough-proof'); // the first run is still active in this process

for (const result of await Promise.all([first, second])) {
  console.log(result.status === 'ran' ? `ran: ${result.value.rows} rows` : result.status);
}

await runtime.stop();
// #endregion run
