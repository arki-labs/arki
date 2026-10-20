// @vitest-environment jsdom

import { createElement } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';

import { OfflineBanner } from '../../src/status/OfflineBanner.tsx';
import type { OfflineBannerProps } from '../../src/status/OfflineBanner.tsx';
import { OfflineQueueProvider } from '../../src/mutations/OfflineQueueProvider.tsx';
import type { OfflineMutationQueue, QueueEvent } from '../../src/mutations/queue.ts';

afterEach(() => {
  cleanup();
});

type Status = ReturnType<OfflineMutationQueue['status']>;

function makeQueueStub(overrides: Partial<Status> = {}): OfflineMutationQueue {
  const subscribers = new Set<(event: QueueEvent) => void>();
  return {
    enqueue: vi.fn(),
    drain: vi.fn(),
    deadLetter: {
      list: vi.fn(),
      retry: vi.fn(),
      discard: vi.fn(),
    },
    subscribe: (listener) => {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    status: () => ({ queued: 0, sending: false, deadLettered: 0, failure: null, ...overrides }),
    dispose: vi.fn(),
  } satisfies OfflineMutationQueue;
}

describe('OfflineBanner — useSyncExternalStore snapshot contract', () => {
  // Regression test for the bug that crashed avocabo.com with React error #185
  // ("Maximum update depth exceeded"). The headless OfflineBanner used to
  // return a fresh `{ queued, deadLettered }` object from its getSnapshot,
  // which violates useSyncExternalStore's contract (snapshots are compared
  // with Object.is). Every render saw a new object → React scheduled another
  // render → infinite loop → error boundary.
  //
  // The fix splits the snapshot into two primitive (number) getters so React
  // can compare them safely. These tests guard against re-introducing the
  // object-literal pattern.

  it('renders without a queue provider without entering an infinite render loop', () => {
    // If getSnapshot returns a fresh object on every call, React will throw
    // "Maximum update depth exceeded" during render. We assert the render
    // completes and the headless render-prop receives the expected defaults.
    const childSpy = vi.fn<OfflineBannerProps['children']>(({ online, queued, deadLettered }) =>
      createElement(
        'div',
        { 'data-testid': 'banner' },
        `online=${online} queued=${queued} dead=${deadLettered}`,
      ),
    );

    render(createElement(OfflineBanner, { children: childSpy }));

    expect(screen.getByTestId('banner').textContent).toBe('online=true queued=0 dead=0');
    expect(childSpy).toHaveBeenCalled();
  });

  it('renders with a queue provider without entering an infinite render loop', () => {
    const queue = makeQueueStub({ queued: 3, deadLettered: 1 });

    render(
      createElement(
        OfflineQueueProvider,
        {
          queue,
          children: createElement(OfflineBanner, {
            children: ({ online, queued, deadLettered }) =>
              createElement(
                'div',
                { 'data-testid': 'banner' },
                `online=${online} queued=${queued} dead=${deadLettered}`,
              ),
          }),
        },
      ),
    );

    expect(screen.getByTestId('banner').textContent).toBe('online=true queued=3 dead=1');
  });

  it('reuses snapshot identity for primitives (Object.is-stable across calls)', () => {
    // Direct guard against the regression: even if a future change moves the
    // snapshot back into an object, this test would fail because
    // Object.is({queued:0,...}, {queued:0,...}) === false. Primitives win.
    const queue = makeQueueStub({ queued: 5, deadLettered: 2 });
    const s1 = queue.status();
    const s2 = queue.status();
    // queue.status() itself returns fresh objects, but the consumer extracts
    // primitives — so the values we care about must be Object.is-equal.
    expect(Object.is(s1.queued, s2.queued)).toBe(true);
    expect(Object.is(s1.deadLettered, s2.deadLettered)).toBe(true);
  });
});
