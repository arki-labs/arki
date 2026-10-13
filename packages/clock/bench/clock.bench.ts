// Speed of @arki/clock against the platform clocks and @sinonjs/fake-timers.
// Run: `bun run bench` (explore) or `bun run bench --profile publish --write-readme`.
//
// @arki/clock is an object you inject; fake-timers patches or imitates the global
// timers. Only the operations where both return the same thing are ranked; the
// rest are scenarios, shown side by side without ratios.

import { createClock, install } from '@sinonjs/fake-timers';

import { compare, defineSuite, scenario } from '@arki/bench';
import { MockClock, SystemClock } from '@arki/clock';

const START = new Date(Date.UTC(2026, 0, 1));

/** True when a value is a `Date` within one second of the real time: "the current time, as a Date". */
const isCurrentDate = (value: Date): boolean => value instanceof Date && Math.abs(value.getTime() - Date.now()) < 1000;

type Step = { start: number; step: number };

export default defineSuite({
  id: '@arki/clock',
  intro:
    'Speed of `@arki/clock` against the platform clocks (`Date`, `performance`) and @sinonjs/fake-timers, the fake clock behind Jest, Vitest and many Sinon setups. A clock abstraction does two things: read real time, and stand in for it in tests.',
  notes: [
    '@arki/clock is a small injected object: your code takes a `Clock` and calls `now()`. @sinonjs/fake-timers imitates (`createClock`) or replaces (`install`) the global `Date`, `setTimeout` and friends, and moves them with `tick`. The two solve the same testing problem with different designs, so most of their rows are scenarios, not rankings.',
    '`SystemClock.now()` returns a fresh `Date`, exactly like `new Date()`; the gap between those rows is the cost of the wrapper. `Date.now()` and `performance.now()` return numbers and skip the allocation, and `performance.now()` counts from process start, not from the epoch.',
    '`MockClock.advance` throws on negative or non-finite input, so time can never run backward by mistake. fake-timers `tick` also refuses negative input, but on every call it looks for due timers, which @arki/clock does not have.',
    '@arki/clock has no timers. Code written against an injected clock checks its own deadlines, so the "fire a due callback" rows do different work and are not ranked.',
  ],
  groups: [
    compare<undefined>({
      id: 'read-real',
      title: 'Read the real time as a Date',
      contract: { id: 'clock-read-real-date/v1', description: 'a fresh `Date` for the current time' },
      inputs: [undefined],
      expected: () => true,
      baseline: 'arki',
      note: 'The check accepts a Date within one second of the real time.',
      cases: c => ({
        arki: c({
          label: '@arki/clock SystemClock.now()',
          package: '@arki/clock',
          setup: () => new SystemClock(),
          run: clock => clock.now(),
          normalize: isCurrentDate,
        }),
        native: c({ label: 'native new Date()', run: () => new Date(), normalize: isCurrentDate }),
        dateNow: c({ label: 'native Date.now()', differs: 'returns a number, no Date', run: () => Date.now() }),
        performance: c({
          label: 'native performance.now()',
          differs: 'returns a number of ms since process start',
          run: () => performance.now(),
        }),
      }),
    }),
    compare<number>({
      id: 'read-fake',
      title: 'Read a fake time as a Date',
      contract: { id: 'clock-read-fake-date/v1', description: 'a `Date` for the instant a stopped fake clock shows' },
      inputs: [START.getTime(), 0, -1, 8.64e15],
      expected: ms => ms,
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/clock MockClock.now()',
          package: '@arki/clock',
          setup: ms => new MockClock(new Date(ms)),
          run: clock => clock.now(),
          normalize: value => value.getTime(),
        }),
        fakeDate: c({
          label: 'fake-timers new clock.Date()',
          package: '@sinonjs/fake-timers',
          setup: ms => createClock(ms),
          run: clock => new clock.Date(),
          normalize: value => value.getTime(),
        }),
        fakeNow: c({
          label: 'fake-timers clock.now',
          package: '@sinonjs/fake-timers',
          differs: 'a number property, no Date',
          setup: ms => createClock(ms),
          run: clock => clock.now,
        }),
      }),
    }),
    compare<Step>({
      id: 'advance',
      title: 'Advance the fake time (no timers pending)',
      contract: {
        id: 'clock-advance-no-timers/v1',
        description: 'the fake time moved forward by a non-negative whole number of milliseconds',
      },
      inputs: [
        { start: START.getTime(), step: 1 },
        { start: START.getTime(), step: 0 },
        { start: -1, step: 86_400_000 },
        { start: 0, step: 1000 },
      ],
      expected: ({ start, step }) => start + step,
      baseline: 'arki',
      note: 'Each call moves the same clock again, so the time keeps growing during timing.',
      cases: c => ({
        arki: c({
          label: '@arki/clock MockClock.advance(ms)',
          package: '@arki/clock',
          setup: ({ start, step }) => ({ clock: new MockClock(new Date(start)), step }),
          run: ({ clock, step }) => {
            clock.advance(step);
            return clock;
          },
          normalize: clock => clock.now().getTime(),
        }),
        fake: c({
          label: 'fake-timers clock.tick(ms)',
          package: '@sinonjs/fake-timers',
          setup: ({ start, step }) => ({ clock: createClock(start), step }),
          run: ({ clock, step }) => {
            clock.tick(step);
            return clock;
          },
          normalize: clock => clock.now,
        }),
      }),
    }),
    scenario({
      kind: 'scenario',
      id: 'fire-due',
      title: 'Schedule a callback 10 ms ahead, advance, run it',
      note: 'Different work: fake-timers keeps a timer queue and runs the callback inside `tick`; the @arki/clock row computes the deadline, advances and calls the callback itself, as code written against an injected clock does.',
      cases: c => ({
        arki: c({
          label: '@arki/clock advance + manual deadline check',
          setup: () => ({ clock: new MockClock(START), fired: { count: 0 } }),
          run: ({ clock, fired }) => {
            const deadline = clock.now().getTime() + 10;
            clock.advance(10);
            if (clock.now().getTime() >= deadline) fired.count++;
            return fired.count;
          },
        }),
        fake: c({
          label: 'fake-timers setTimeout + tick(10)',
          setup: () => ({ clock: createClock(START), fired: { count: 0 } }),
          run: ({ clock, fired }) => {
            clock.setTimeout(() => {
              fired.count++;
            }, 10);
            clock.tick(10);
            return fired.count;
          },
        }),
      }),
    }),
    scenario({
      kind: 'scenario',
      id: 'create',
      title: 'Create a fresh fake clock',
      note: 'The per-test setup cost. Different work: `createClock` builds a full fake timer API (Date class, timers, queue); `install` also patches the globals, so its row includes `uninstall`. `new MockClock` stores one number.',
      cases: c => ({
        arki: c({ label: '@arki/clock new MockClock(date)', run: () => new MockClock(START) }),
        fakeCreate: c({ label: 'fake-timers createClock(date)', run: () => createClock(START) }),
        fakeInstall: c({
          label: 'fake-timers install(), then uninstall()',
          run: () => {
            const clock = install({ now: START });
            const now = clock.now;
            clock.uninstall();
            return now;
          },
        }),
      }),
    }),
  ],
});
