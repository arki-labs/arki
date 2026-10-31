/* eslint-disable @typescript-eslint/unbound-method -- the stubs are vi.fn() mocks; asserting on them never detaches `this` */
// @vitest-environment jsdom
import { mutationIdempotencyKey } from '../../src/mutations/identity.ts';

import { createElement } from 'react';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { oc } from '@orpc/contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { OPERATION, operations } from '@arki/contracts/orpc';

import type { OfflineMutationQueue, QueueEvent } from '../../src/mutations/queue.ts';
import { useOfflineMutation, useQueueStatus } from '../../src/mutations/hooks.ts';
import { OfflineQueueProvider } from '../../src/mutations/OfflineQueueProvider.tsx';
import { offlineSafe } from '../../src/orpc/offline-safe-marker.ts';

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
    status: () => ({ queued: 0, sending: false, deadLettered: 0, failure: null, ...overrides }),
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

    render(createElement(OfflineQueueProvider, { queue, children: createElement(QueueStatusView) }));

    expect(screen.getByTestId('queue-status').textContent).toBe('queued=2 sending=true dead=1');
  });
});

describe('useOfflineMutation', () => {
  it('enqueues through the carrier it was given, so the queue persists the contract path', async () => {
    const contract = { highlights: { create: offlineSafe(oc.input(z.object({ text: z.string() }))) } };
    const carrier = { [OPERATION]: operations(contract).highlights.create };
    const queue = makeQueueStub();
    vi.mocked(queue.enqueue).mockResolvedValue({ idempotencyKey: mutationIdempotencyKey.schema.parse('k1'), status: 'queued' });

    const { result } = renderHook(() => useOfflineMutation(carrier), {
      wrapper: ({ children }) => createElement(OfflineQueueProvider, { queue, children }),
    });
    const sent = await act(() => result.current.mutate({ text: 'hi' }));

    expect(sent).toEqual({ idempotencyKey: 'k1', status: 'queued' });
    expect(queue.enqueue).toHaveBeenCalledWith(carrier, { text: 'hi' });
    expect(carrier[OPERATION].path).toEqual(['highlights', 'create']);
  });
});

it('preserves the exact failure for the caller and exposes it to the UI', async () => {
  const { QueueStorageUnavailable } = await import('../../src/mutations/failures.ts');
  const contract = { create: offlineSafe(oc.input(z.object({ text: z.string() }))) };
  const carrier = { [OPERATION]: operations(contract).create };
  const queue = makeQueueStub();
  const failure = QueueStorageUnavailable();
  vi.spyOn(queue, 'enqueue').mockResolvedValue(failure);
  const { result } = renderHook(() => useOfflineMutation(carrier), {
    wrapper: ({ children }) => createElement(OfflineQueueProvider, { queue, children }),
  });
  expect(await act(() => result.current.mutate({ text: 'hi' }))).toBe(failure);
  expect(result.current.failure).toBe(failure);
  expect(result.current.isPending).toBe(false);
});
