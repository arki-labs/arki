// @vitest-environment jsdom

import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OfflineMutationQueue, QueueEvent } from '../../src/mutations/queue.ts';
import { useQueueStatus } from '../../src/mutations/hooks.ts';
import { OfflineQueueProvider } from '../../src/mutations/OfflineQueueProvider.tsx';

afterEach(() => {
  cleanup();
});

type QueueStatus = ReturnType<OfflineMutationQueue['status']>;

function makeQueueStub(overrides: Partial<QueueStatus> = {}): OfflineMutationQueue {
  const subscribers = new Set<(event: QueueEvent) => void>();

  return {
    enqueue: vi.fn(),
    drain: vi.fn(),
    deadLetter: {
      list: vi.fn(),
      retry: vi.fn(),
      discard: vi.fn(),
    },
    subscribe: listener => {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
    status: () => ({ queued: 0, sending: false, deadLettered: 0, ...overrides }),
    dispose: vi.fn(),
  } satisfies OfflineMutationQueue;
}

function QueueStatusView() {
  const status = useQueueStatus();

  return createElement(
    'div',
    { 'data-testid': 'queue-status' },
    `queued=${status.queued} sending=${status.sending} dead=${status.deadLettered}`,
  );
}

describe('useQueueStatus', () => {
  it('renders with a fresh-object queue.status implementation without looping', () => {
    const queue = makeQueueStub({ queued: 2, sending: true, deadLettered: 1 });

    render(createElement(OfflineQueueProvider, { queue }, createElement(QueueStatusView)));

    expect(screen.getByTestId('queue-status').textContent).toBe('queued=2 sending=true dead=1');
  });
});
