// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useUserChange } from './user-change.js';

/** Mounts the hook with `userId` (none = still loading); `next` changes the user, `loading` refetches. */
const mount = (userId?: string | null) => {
  const onUserChange = vi.fn<(userId: string | null) => void>();
  const hook = renderHook(({ id }) => useUserChange(id, onUserChange), { initialProps: { id: userId } });
  return {
    onUserChange,
    next: (id: string | null) => hook.rerender({ id }),
    loading: () => hook.rerender({ id: undefined }),
  };
};

// Apps hang per-user cleanup on this (dropping one user's offline caches before the next
// user sees them), so a missed report leaks data and a report while loading wipes caches
// for a user who never left.
describe('useUserChange', () => {
  it('stays quiet while the session is still loading', () => {
    const { onUserChange } = mount();
    expect(onUserChange).not.toHaveBeenCalled();
  });

  it('reports the user once the session loads signed in', () => {
    const { onUserChange, next } = mount();
    next('usr_a');
    expect(onUserChange.mock.calls).toEqual([['usr_a']]);
  });

  it('reports null once the session loads signed out', () => {
    const { onUserChange } = mount(null);
    expect(onUserChange.mock.calls).toEqual([[null]]);
  });

  it('reports sign-in, sign-out and a switch to another user, in order', () => {
    const { onUserChange, next } = mount(null);
    next('usr_a');
    next(null);
    next('usr_b');
    expect(onUserChange.mock.calls).toEqual([[null], ['usr_a'], [null], ['usr_b']]);
  });

  it('reports a user replaced without a sign-out in between', () => {
    // An expired session replaced by another account's never passes through `null`.
    const { onUserChange, next } = mount('usr_a');
    next('usr_b');
    expect(onUserChange.mock.calls).toEqual([['usr_a'], ['usr_b']]);
  });

  it('does not report the same user twice, even across a refetch that loads again', () => {
    const { onUserChange, next, loading } = mount('usr_a');
    next('usr_a');
    loading();
    next('usr_a');
    expect(onUserChange.mock.calls).toEqual([['usr_a']]);
  });

  it('does not report again when only the callback changes', () => {
    // Apps often pass an inline arrow, which is a new function on every render.
    const first = vi.fn<(userId: string | null) => void>();
    const second = vi.fn<(userId: string | null) => void>();
    const hook = renderHook(({ cb }) => useUserChange('usr_a', cb), { initialProps: { cb: first } });
    hook.rerender({ cb: second });
    expect(first.mock.calls).toEqual([['usr_a']]);
    expect(second).not.toHaveBeenCalled();
  });
});
