import React, { act } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeProvider, useTheme } from '../theme-context';

const storageKey = 'hydration-test-theme';

/**
 * Exposes the theme only through an attribute, like a theme switcher's `aria-checked`.
 * React patches mismatched text during hydration but keeps mismatched attributes,
 * which is exactly how a stored theme used to leave the server's "system" on screen.
 */
function ThemeProbe() {
  const { theme } = useTheme();
  return <output data-theme={theme} />;
}

const app = (
  <ThemeProvider themes={['light', 'dark', 'system']} defaultTheme="system" storageKey={storageKey}>
    <ThemeProbe />
  </ThemeProvider>
);

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('theme provider hydration', () => {
  it('shows the stored theme after hydrating server HTML that could not read storage', () => {
    // The server has no localStorage, so it renders the default theme.
    const container = document.createElement('div');
    container.innerHTML = renderToString(app);
    document.body.append(container);
    expect(container.querySelector('output')?.dataset.theme).toBe('system');

    // The visitor chose dark on an earlier visit.
    localStorage.setItem(storageKey, 'dark');
    const onRecoverableError = vi.fn();
    act(() => {
      hydrateRoot(container, app, { onRecoverableError });
    });

    expect(container.querySelector('output')?.dataset.theme).toBe('dark');
    expect(onRecoverableError).not.toHaveBeenCalled();
  });

  it('never applies the default theme over the pre-painted stored one, so the page does not flash', () => {
    const container = document.createElement('div');
    container.innerHTML = renderToString(app);
    document.body.append(container);

    // The pre-paint script already applied the stored dark theme.
    localStorage.setItem(storageKey, 'dark');
    const root = document.documentElement;
    root.className = 'dark';
    // Each record's oldValue is a class list the page had, in order. Switching themes
    // passes through an empty list inside one synchronous call, which never paints;
    // a light class, though, means the default theme was applied over the stored one.
    const classStates: string[] = [];
    const record = (records: MutationRecord[]) => {
      for (const mutation of records) classStates.push(mutation.oldValue ?? '');
    };
    const observer = new MutationObserver(record);
    observer.observe(root, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });

    act(() => {
      hydrateRoot(container, app);
    });

    record(observer.takeRecords());
    classStates.push(root.className);
    observer.disconnect();
    root.className = '';
    for (const state of classStates) expect(state.split(' ')).not.toContain('light');
    expect(classStates.at(-1)?.split(' ')).toContain('dark');
  });
});
