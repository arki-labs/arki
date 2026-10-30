import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useAsyncMemo } from '../hooks/async-memo';

describe('useAsyncMemo', () => {
  it('keeps a rejection as `failure` instead of dropping it, and retry runs the factory again', async () => {
    let calls = 0;
    const { result } = renderHook(() =>
      useAsyncMemo(() => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('plugin broke')) : Promise.resolve('ok');
      }, []),
    );

    await waitFor(() => {
      expect(result.current.failure).toBeInstanceOf(Error);
    });
    expect(result.current.isPending).toBe(false);
    expect(result.current.value).toBeUndefined();

    act(() => {
      result.current.retry();
    });
    await waitFor(() => {
      expect(result.current.value).toBe('ok');
    });
    expect(result.current.failure).toBeUndefined();
    expect(calls).toBe(2);
  });

  it('drops the result of a run whose dependencies changed before it resolved', async () => {
    const { result, rerender } = renderHook(
      ({ text }) => useAsyncMemo(() => new Promise<string>(resolve => setTimeout(() => resolve(text), text === 'a' ? 30 : 1)), [text]),
      { initialProps: { text: 'a' } },
    );
    rerender({ text: 'b' });
    await waitFor(() => {
      expect(result.current.value).toBe('b');
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(result.current.value).toBe('b');
  });
});
