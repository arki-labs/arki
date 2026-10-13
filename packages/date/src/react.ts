/**
 * React 19 hooks that keep a Temporal value in step with a clock.
 * Import from `@arki/date/react`; `react` is an optional peer dependency.
 *
 * The first render reads the clock synchronously, so server and client both
 * render a value. Pass a `MockClock` for deterministic tests.
 */

import { useEffect, useState } from 'react';

import type { Clock } from '@arki/clock';

import type { RelativeOptions } from './relative.js';
import type { Instant, PlainDate, Timeline } from './types.js';
import { now, today } from './clock.js';
import { relative } from './relative.js';

// This package compiles without DOM or Node typings; timers exist in every supported runtime.
// The package compiles without DOM or Node typings (it runs on both); timers are
// the one host global these hooks need, declared here with the shape every runtime shares.
declare function setInterval(handler: () => void, timeout: number): unknown;
declare function clearInterval(id: unknown): void;

/** How often a hook re-reads the clock. */
export type NowOptions = Readonly<{
  /** Milliseconds between ticks. `0` or `Infinity` means never tick. */
  every?: number;
  /** Clock to read. Default: the system clock. */
  clock?: Clock;
}>;

/** Run `tick` every `every` ms; `0`, `Infinity` and negatives never tick. Returns the cleanup. */
function startTicker(every: number, tick: () => void): (() => void) | undefined {
  if (!Number.isFinite(every) || every <= 0) return undefined;
  const id = setInterval(tick, every);
  return () => {
    clearInterval(id);
  };
}

/** The current `Instant`, re-read every `every` ms (default 1000). */
export function useNow(options?: NowOptions): Instant {
  const clock = options?.clock;
  const [value, setValue] = useState(() => now({ clock }));
  const every = options?.every ?? 1000;
  useEffect(() => startTicker(every, () => setValue(now({ clock }))), [every, clock]);
  return value;
}

/**
 * Today's date in `timeZone` (runtime zone by default), re-read every `every`
 * ms (default 60 000). It only re-renders when the date changes.
 */
export function useToday(options?: NowOptions & Readonly<{ timeZone?: string }>): PlainDate {
  const clock = options?.clock;
  const timeZone = options?.timeZone;
  const [value, setValue] = useState(() => today({ clock, timeZone }));
  const every = options?.every ?? 60_000;
  useEffect(
    () =>
      startTicker(every, () => {
        const next = today({ clock, timeZone });
        setValue(previous => (previous.equals(next) ? previous : next));
      }),
    [every, clock, timeZone],
  );
  return value;
}

/** `relative(target, now)` text such as "in 3 minutes", refreshed every `every` ms (default 60 000). */
export function useRelativeTime(target: Timeline | Date, options?: RelativeOptions & NowOptions): string {
  const clock = options?.clock;
  const [reference, setReference] = useState(() => now({ clock }));
  const every = options?.every ?? 60_000;
  useEffect(() => startTicker(every, () => setReference(now({ clock }))), [every, clock]);
  return relative(target, reference, options);
}
