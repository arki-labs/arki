/// <reference types="node" />

import { runInNewContext } from 'node:vm';
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { themeScript } from '../script';
import { ThemeProvider, useTheme } from '../theme-context';

function Preference() {
  const { resolvedTheme } = useTheme();
  return <output>{resolvedTheme}</output>;
}

function mediaQuery(matches: boolean) {
  return {
    matches,
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  } satisfies MediaQueryList;
}

function assertApplied(theme: string) {
  expect(document.documentElement.classList.contains(theme)).toBe(true);
  expect(document.documentElement.classList.contains('dark')).toBe(theme === 'dark');
  expect(document.documentElement.classList.contains('is-dark')).toBe(theme === 'dark');
  expect(document.documentElement.style.colorScheme).toBe(theme === 'dark' ? 'dark' : 'light');
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = '';
  document.documentElement.removeAttribute('style');
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => mediaQuery(true)),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('restricted browser theme fallbacks', () => {
  it.each(['missing', 'throwing'])('keeps provider and serialized script light when matchMedia is %s', fault => {
    vi.stubGlobal(
      'matchMedia',
      fault === 'missing'
        ? undefined
        : vi.fn(() => {
            throw new Error('blocked');
          }),
    );
    runInNewContext(themeScript(), { window, document, localStorage });
    assertApplied('light');
    document.documentElement.className = '';
    render(
      <ThemeProvider>
        <Preference />
      </ThemeProvider>,
    );
    expect(screen.getByRole('status').textContent).toBe('light');
    assertApplied('light');
  });

  it.each(['dark', 'system'])('applies the %s default despite blocked storage', defaultTheme => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    runInNewContext(themeScript({ defaultTheme }), { window, document, localStorage });
    assertApplied('dark');
    document.documentElement.className = '';
    render(
      <ThemeProvider defaultTheme={defaultTheme}>
        <Preference />
      </ThemeProvider>,
    );
    expect(screen.getByRole('status').textContent).toBe('dark');
    assertApplied('dark');
  });

  it('retains light when storage and system detection are both blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.stubGlobal('matchMedia', null);
    runInNewContext(themeScript(), { window, document, localStorage });
    assertApplied('light');
    render(
      <ThemeProvider>
        <Preference />
      </ThemeProvider>,
    );
    assertApplied('light');
  });

  it('preserves disabled system resolution without subscribing', () => {
    const query = mediaQuery(true);
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => query),
    );
    runInNewContext(themeScript({ enableSystem: false }), { window, document, localStorage });
    assertApplied('system');
    render(
      <ThemeProvider enableSystem={false}>
        <Preference />
      </ThemeProvider>,
    );
    expect(screen.getByRole('status').textContent).toBe('system');
    expect(query.addEventListener).not.toHaveBeenCalled();
    assertApplied('system');
  });

  it('keeps the detected preference when subscription throws', () => {
    const query = mediaQuery(true);
    query.addEventListener.mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => query),
    );
    render(
      <ThemeProvider>
        <Preference />
      </ThemeProvider>,
    );
    expect(screen.getByRole('status').textContent).toBe('dark');
    assertApplied('dark');
  });

  it('handles subscription cleanup faults', () => {
    const query = mediaQuery(true);
    query.removeEventListener.mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => query),
    );
    const view = render(
      <ThemeProvider>
        <Preference />
      </ThemeProvider>,
    );
    expect(() => view.unmount()).not.toThrow();
    expect(query.removeEventListener).toHaveBeenCalled();
  });

  it('keeps unknown stored values and custom attributes aligned', () => {
    localStorage.setItem('theme', 'unknown');
    runInNewContext(themeScript({ attribute: 'data-theme', defaultTheme: 'dark' }), { window, document, localStorage });
    expect(document.documentElement.dataset['theme']).toBe('dark');
    assertApplied('dark');
    render(
      <ThemeProvider attribute="data-theme" defaultTheme="dark">
        <Preference />
      </ThemeProvider>,
    );
    expect(document.documentElement.dataset['theme']).toBe('dark');
    assertApplied('dark');
  });
});
