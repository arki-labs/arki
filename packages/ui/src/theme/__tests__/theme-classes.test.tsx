/// <reference types="node" />

import { runInNewContext } from 'node:vm';
import React from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { themeScript } from '../script';
import type { ThemeProviderProps } from '../theme-context';
import { ThemeProvider, useTheme } from '../theme-context';

const themes = ['light', 'candle-light', 'candle-dark', 'dark', 'system'];
const themeClasses = {
  light: [],
  'candle-light': ['candlelight'],
  'candle-dark': ['dark', 'candlelight'],
  dark: ['dark'],
} as const;
const options = { themes, themeClasses, defaultTheme: 'system' };

const root = document.documentElement;
const has = (name: string) => root.classList.contains(name);

function stubSystem(dark: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: dark,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

function mountProvider(props: Omit<ThemeProviderProps, 'children'>) {
  return renderHook(() => useTheme(), {
    wrapper: ({ children }) => <ThemeProvider {...props}>{children}</ThemeProvider>,
  });
}

beforeEach(() => {
  localStorage.clear();
  root.className = '';
  root.removeAttribute('style');
  stubSystem(true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('theme classes', () => {
  it('script: candle-dark sets dark, candlelight and a dark color-scheme', () => {
    localStorage.setItem('theme', 'candle-dark');
    runInNewContext(themeScript(options), { window, document, localStorage });
    expect(has('dark') && has('candlelight')).toBe(true);
    expect(root.style.colorScheme).toBe('dark');
  });

  it('script: candle-light is a light scheme with only candlelight', () => {
    localStorage.setItem('theme', 'candle-light');
    runInNewContext(themeScript(options), { window, document, localStorage });
    expect(has('candlelight')).toBe(true);
    expect(has('dark')).toBe(false);
    expect(root.style.colorScheme).toBe('light');
  });

  it('script: leaves no stale class from an earlier theme on the page', () => {
    root.className = 'dark candlelight';
    localStorage.setItem('theme', 'light');
    runInNewContext(themeScript(options), { window, document, localStorage });
    expect(has('dark') || has('candlelight') || has('is-dark')).toBe(false);
    expect(root.style.colorScheme).toBe('light');
  });

  it.each([true, false])('system never resolves to a candle theme (system dark: %s)', systemDark => {
    stubSystem(systemDark);
    runInNewContext(themeScript(options), { window, document, localStorage });
    expect(has('candlelight')).toBe(false);
    expect(has('dark')).toBe(systemDark);
  });

  it('provider: switching candle-dark back to light removes both classes', () => {
    const view = mountProvider({ themes, themeClasses, defaultTheme: 'candle-dark' });
    expect(has('dark') && has('candlelight')).toBe(true);
    expect(root.style.colorScheme).toBe('dark');
    act(() => view.result.current.setTheme('light'));
    expect(has('dark') || has('candlelight') || has('is-dark')).toBe(false);
    expect(root.style.colorScheme).toBe('light');
  });

  it('provider: system with no stored choice follows the OS and never picks candle', () => {
    mountProvider({ themes, themeClasses });
    expect(has('dark')).toBe(true);
    expect(has('candlelight')).toBe(false);
  });

  it('an app that does not opt in keeps the old classes: the theme name, plus is-dark', () => {
    runInNewContext(themeScript({ defaultTheme: 'dark' }), { window, document, localStorage });
    expect(new Set(root.classList)).toEqual(new Set(['dark', 'is-dark']));
    root.className = '';
    const view = mountProvider({ themes: ['light', 'dark', 'sepia', 'system'], defaultTheme: 'sepia' });
    expect([...root.classList]).toEqual(['sepia']);
    act(() => view.result.current.setTheme('dark'));
    expect(new Set(root.classList)).toEqual(new Set(['dark', 'is-dark']));
  });
});
