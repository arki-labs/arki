/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { arkiPaletteLabels } from './palette-labels';
import { arkiThemeClasses, arkiThemes } from './themes';

const tokens = readFileSync(new URL('tokens.css', import.meta.url), 'utf8');

describe('arkiThemes', () => {
  it('only uses classes that tokens.css defines, so no theme selects nothing', () => {
    const classes = new Set(Object.values(arkiThemeClasses).flat());
    expect(classes.size).toBeGreaterThan(0);
    for (const name of classes) {
      expect(tokens, `.${name} is missing from tokens.css`).toMatch(new RegExp(`\\.${name}\\b`));
    }
  });

  it('lists every themed value once, with system last, so the picker order is stable', () => {
    expect(new Set(arkiThemes).size).toBe(arkiThemes.length);
    expect(arkiThemes.at(-1)).toBe('system');
    expect(new Set(Object.keys(arkiThemeClasses))).toEqual(new Set(arkiThemes.filter(name => name !== 'system')));
  });

  it('marks dark only on the two dark themes, because color-scheme follows it', () => {
    const dark = Object.entries(arkiThemeClasses)
      .filter(([, classes]) => (classes as readonly string[]).includes('dark'))
      .map(([name]) => name);
    expect(new Set(dark)).toEqual(new Set(['candle-dark', 'dark']));
  });

  it('labels both candle palettes', () => {
    expect(arkiPaletteLabels['candle-light']).toBeTruthy();
    expect(arkiPaletteLabels['candle-dark']).toBeTruthy();
  });
});
