/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

import { paletteLabelsSchema } from '@fleet/design-systems/palette-labels';
import { parseTypographyRoster } from '@fleet/design-systems/typography';

import { arkiPaletteLabels } from './palette-labels';
import { arkiTypography } from './typography';

const packageRequire = createRequire(import.meta.url);

/** A file of arki, or of workbench (from `@fleet/design-systems`), the system arki must stay a drop-in for. */
function read(system: 'arki' | 'workbench', file: string): string {
  const path =
    system === 'arki'
      ? new URL(file, import.meta.url)
      : packageRequire.resolve(`@fleet/design-systems/workbench/${file}`);
  return readFileSync(path, 'utf8');
}

// Every custom property a stylesheet defines, in order of first appearance.
function tokenNames(css: string): string[] {
  return [...new Set([...css.matchAll(/^\s*--([a-z0-9-]+):/gm)].map(match => match[1] ?? ''))];
}

// A stylesheet without its comments, so two files that differ only in comments compare equal.
function withoutComments(css: string): string {
  return css.replaceAll(/\/\*[\s\S]*?\*\//g, '');
}

describe('arkiTypography', () => {
  it('parses as a valid TypographyRoster', () => {
    expect(() => parseTypographyRoster(arkiTypography)).not.toThrow();
  });

  // Founder decision C-DS-1: Archivo is the heading face, and the roster must open on it.
  it('opens on Archivo and offers no serif', () => {
    const fonts = arkiTypography.variants.map(variant => variant.fontFamily).join(' ');
    expect(arkiTypography.default).toBe('archivo');
    expect(fonts).not.toMatch(/Instrument Serif/);
  });
});

describe('arkiPaletteLabels', () => {
  it('parses as valid PaletteLabels', () => {
    expect(() => paletteLabelsSchema.parse(arkiPaletteLabels)).not.toThrow();
  });

  // The modes carry the brand palette names, so a theme switcher reads "mineral", "signal" and the two
  // Candlelight palettes instead of generic light/dark words.
  it('names the modes after the brand palettes (mineral / auto / signal / parchment / drafting table)', () => {
    expect(arkiPaletteLabels).toEqual({
      light: 'mineral',
      system: 'auto',
      dark: 'signal',
      'candle-light': 'parchment',
      'candle-dark': 'drafting table',
    });
  });
});

describe('arki fonts', () => {
  const tokens = read('arki', 'tokens.css');
  const fontsCss = read('arki', 'fonts.css');
  const fontsTs = read('arki', 'fonts.ts');

  // The founder dislikes Instrument Serif (workbench's display face); arki must never load or name it.
  it('never loads or names Instrument Serif', () => {
    for (const source of [tokens, fontsCss, fontsTs]) {
      expect(source).not.toMatch(/instrument[- ]serif/i);
    }
  });

  // C-DS-1: Archivo headings, IBM Plex Sans body, JetBrains Mono code. A swap here is a brand change.
  it('names Archivo, IBM Plex Sans and JetBrains Mono in its font tokens', () => {
    expect(tokens).toMatch(/--heading-font: 'Archivo Variable'/);
    expect(tokens).toMatch(/--font-sans: 'IBM Plex Sans Variable'/);
    expect(tokens).toMatch(/--font-mono: 'JetBrains Mono Variable'/);
  });

  // arki owns its type: pulling workbench's fonts would bring Instrument Serif and Work Sans back.
  it('does not import the workbench fonts', () => {
    expect(fontsCss).not.toMatch(/workbench/);
  });
});

describe('arki tokens', () => {
  const tokens = read('arki', 'tokens.css');

  // arki is a drop-in for workbench: one shared component must render in either, so no workbench name may be missing.
  it('defines every token workbench defines', () => {
    const arkiNames = new Set(tokenNames(tokens));
    expect(tokenNames(read('workbench', 'tokens.css')).filter(name => !arkiNames.has(name))).toEqual([]);
  });

  // The brand colours come from the brand kit (source-dot mineral and signal); a drift here is a brand change.
  it('uses the mineral palette in light and the signal palette in dark', () => {
    const [light = '', dark = ''] = tokens.split(/^\.dark \{/m);
    expect(light).toMatch(/--background: #f2f0e9;/);
    expect(light).toMatch(/--foreground: #182338;/);
    expect(light).toMatch(/--primary: #234deb;/);
    expect(dark).toMatch(/--background: #11191f;/);
    expect(dark).toMatch(/--foreground: #e7ebeb;/);
    expect(dark).toMatch(/--primary: #ff683b;/);
  });

  it('exposes the soap-bubble signature', () => {
    for (const name of ['arki-bubble-1', 'arki-bubble-2', 'arki-bubble-3', 'arki-bubble-4', 'arki-bubble-gradient']) {
      expect(tokens).toMatch(new RegExp(`^\\s*--${name}:`, 'm'));
    }
  });

  describe('Candlelight', () => {
    // The class sits next to the mode, so .dark still drives Tailwind's dark: variant; a split finds nothing if a selector drifts.
    const block = (selector: RegExp): string => (tokens.split(selector)[1] ?? '').split(/^\}/m)[0] ?? '';
    const darkBlock = block(/^\.dark \{/m);
    const candleLight = block(/^\.candlelight \{/m);
    const candleDark = block(/^\.dark\.candlelight \{/m);

    // A token Candlelight forgets falls through to mineral or signal, and a cobalt or orange shows up under the candle.
    it.each([
      ['light', candleLight],
      ['dark', candleDark],
    ])('restates every colour token in %s', (_mode, candle) => {
      const candleNames = new Set(tokenNames(candle));
      expect(tokenNames(darkBlock).filter(name => !candleNames.has(name))).toEqual([]);
    });

    it('uses parchment, sepia ink and a deep amber in light', () => {
      expect(candleLight).toMatch(/--background: #f3e7d3;/);
      expect(candleLight).toMatch(/--foreground: #2b1d12;/);
      expect(candleLight).toMatch(/--primary: #9a4217;/);
    });

    it('uses warm night, parchment and the bubble amber in dark', () => {
      expect(candleDark).toMatch(/--background: #16100b;/);
      expect(candleDark).toMatch(/--foreground: #e2d3b8;/);
      expect(candleDark).toMatch(/--primary: #f0935d;/);
    });

    // The glow is safe to use in any mode: it is off unless Candlelight is on.
    it('lights the page only in Candlelight', () => {
      expect(tokens.split(/^\.dark \{/m)[0]).toMatch(/--arki-candle-glow: none;/);
      expect(candleLight).toMatch(/--arki-candle-glow: radial-gradient\(/);
      expect(candleDark).toMatch(/--arki-candle-glow: radial-gradient\(/);
    });
  });

  it('bridges to Tailwind exactly like workbench', () => {
    expect(withoutComments(read('arki', 'theme-bridge.css'))).toBe(
      withoutComments(read('workbench', 'theme-bridge.css')),
    );
  });
});

// Shared UI (`@arki/ui/callout`) styles itself with the status tokens, so a theme that skips one renders a callout with
// no colour. Arki has four theme blocks: mineral, signal and the two Candlelight palettes.
describe('arki status tokens', () => {
  const tokens = read('arki', 'tokens.css');
  const bridge = read('arki', 'theme-bridge.css');
  const names = ['success', 'warning', 'info'].flatMap(status => [status, `${status}-surface`]);

  it.each([...names, 'destructive-surface'])('defines --%s in all four themes and bridges it to Tailwind', name => {
    expect(tokens.match(new RegExp(`^\\s*--${name}:`, 'gm')) ?? []).toHaveLength(4);
    expect(bridge).toContain(`--color-${name}: var(--${name});`);
  });
});
