import type { RefObject } from 'react';
import { useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';

import { useTheme } from '@arki/ui/theme';

import type { ArkiTheme } from '~/styles/arki/themes';

type ModeTheme = Exclude<ArkiTheme, 'system'>;

const MODES = [
  { theme: 'light', label: 'Light', palette: 'Mineral' },
  { theme: 'candle-light', label: 'Candle light', palette: 'Parchment' },
  { theme: 'candle-dark', label: 'Candle dark', palette: 'Drafting table' },
  { theme: 'dark', label: 'Dark', palette: 'Signal' },
] as const satisfies readonly { theme: ModeTheme; label: string; palette: string }[];

/** How each mode enters, as the `data-vt` value the stylesheet keys on. */
const REVEAL = {
  dark: 'arch',
  light: 'sweep',
  'candle-dark': 'candle',
  'candle-light': 'candle-soft',
} as const satisfies Record<ModeTheme, string>;

/** Counts reveals, so a slow one finishing does not clear the properties of a newer one. */
let latestReveal = 0;

const px = (value: number) => `${Math.round(value)}px`;

/**
 * Sets the geometry of the reveal, measured on the part of the page in view so the effect plays where the reader is
 * looking. Returns the properties it set on `<html>`, so they can be removed afterwards.
 */
function setRevealGeometry(root: HTMLElement, stage: HTMLElement, theme: ModeTheme): string[] {
  const box = stage.getBoundingClientRect();
  const width = box.width;
  const top = Math.max(0, -box.top);
  const bottom = Math.max(top + 1, Math.min(box.height, window.innerHeight - box.top));
  const props: Record<string, string> = {};
  const kind = REVEAL[theme];
  if (kind === 'arch') {
    // A circle centred far below the view: its rising edge reads as an arch.
    const centerY = bottom + width;
    props['--vt-from'] = `circle(${px(width)} at ${px(width / 2)} ${px(centerY)})`;
    props['--vt-to'] = `circle(${px(Math.hypot(width / 2, centerY - top) + 2)} at ${px(width / 2)} ${px(centerY)})`;
  } else if (kind === 'sweep') {
    // Daylight sweeps across at 30 degrees, the drafting angle.
    const slope = Math.tan(Math.PI / 6);
    const quad = (reach: number) =>
      `polygon(0px 0px, ${px(reach)} 0px, ${px(reach)} ${px(top)}, 0px ${px(top + reach * slope)})`;
    props['--vt-from'] = quad(0);
    props['--vt-to'] = quad(width + (bottom - top) / slope + 2);
  } else {
    // The candle sits 22% across, at the top of the view.
    const x = width * 0.22;
    props['--vt-x'] = px(x);
    props['--vt-y'] = px(top);
    props['--vt-r'] = px(Math.hypot(Math.max(x, width - x), bottom - top));
    props['--vt-edge'] = kind === 'candle' ? '120px' : '260px';
  }
  for (const [name, value] of Object.entries(props)) root.style.setProperty(name, value);
  root.dataset.vt = kind;
  return Object.keys(props);
}

/**
 * Switches the theme with a reveal when the browser can play one, otherwise at once. The new classes must be on
 * <html> before the callback returns (hence flushSync), or the "new" picture would still show the old theme.
 */
function switchTheme(stage: HTMLElement, theme: ModeTheme, setTheme: (theme: string) => void) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced || !('startViewTransition' in document)) {
    setTheme(theme);
    return;
  }
  const root = document.documentElement;
  const props = setRevealGeometry(root, stage, theme);
  latestReveal += 1;
  const mine = latestReveal;
  const clear = () => {
    if (mine !== latestReveal) return;
    delete root.dataset.vt;
    for (const name of props) root.style.removeProperty(name);
  };
  document.startViewTransition(() => flushSync(() => setTheme(theme))).finished.then(clear, clear);
}

/** Nothing ever changes: the snapshot only differs between the server (false) and the browser (true). */
const unsubscribeNothing = () => {
  // nothing to unsubscribe from
};

function subscribeNever() {
  return unsubscribeNothing;
}

type ModeSwitchProps = {
  /** The element whose pixels the reveal plays over. */
  stage: RefObject<HTMLElement | null>;
};

/**
 * The theme picker: four swatch cards in a radio group, so the arrow keys move between them. Each card previews its
 * own palette. The checked card also shows a ring and a check mark, not only a colour.
 */
export function ModeSwitch({ stage }: Readonly<ModeSwitchProps>) {
  const { theme: storedTheme, resolvedTheme, setTheme } = useTheme();
  // The chosen theme, or the mode the system resolved to while nothing is chosen.
  const selected = storedTheme === undefined || storedTheme === 'system' ? resolvedTheme : storedTheme;
  // The stored theme is only known in the browser, so the checked card waits for hydration.
  const hydrated = useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );

  function choose(theme: ModeTheme) {
    if (theme === selected) return;
    const stageElement = stage.current;
    if (!stageElement) {
      setTheme(theme);
      return;
    }
    switchTheme(stageElement, theme, setTheme);
  }

  return (
    <fieldset className="home-themes">
      <legend>Theme</legend>
      {MODES.map(({ theme, label, palette }) => (
        <label key={theme} className="home-swatch" data-mode={theme}>
          <input
            type="radio"
            name="home-theme"
            value={theme}
            checked={hydrated && selected === theme}
            onChange={() => choose(theme)}
          />
          <span className="home-swatch-preview" aria-hidden="true">
            <i className="home-swatch-ink" />
            <i className="home-swatch-dot" />
          </span>
          <svg className="home-swatch-check" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3.5 8.5l3 3 6-7" />
          </svg>
          <span className="home-swatch-label">{label}</span>
          <span className="home-swatch-palette">{palette}</span>
        </label>
      ))}
    </fieldset>
  );
}
