// @vitest-environment jsdom
/**
 * Devtools are a dev convenience: when their lazy chunk fails to load (a
 * proxy cut a large dep short, a stale Vite optimize hash), the app beside
 * them must keep rendering. Before the boundary, the rejected `import()`
 * reached the root route and the whole page stopped.
 */
import { createElement, Fragment } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DevTools } from './devtools';

vi.mock('./devtools.impl', () => {
  throw new Error('Failed to fetch dynamically imported module');
});

afterEach(cleanup);

describe('DevTools', () => {
  it('contains a failed chunk load and keeps the app beside it', async () => {
    // React calls this only when an error boundary caught the error.
    const onCaughtError = vi.fn();
    const { container } = render(
      createElement(Fragment, null, createElement('p', null, 'the app'), createElement(DevTools)),
      {
        onCaughtError,
      },
    );

    await waitFor(() => expect(onCaughtError).toHaveBeenCalledOnce());
    expect(screen.getByText('the app')).toBeTruthy();
    expect(container.childElementCount).toBe(1);
  });
});
