import type { Extension } from '@codemirror/state';

import { atomone } from '@uiw/codemirror-theme-atomone';
import { dracula } from '@uiw/codemirror-theme-dracula';
import { eclipse } from '@uiw/codemirror-theme-eclipse';
import { githubDark, githubLight } from '@uiw/codemirror-theme-github';
import { gruvboxDark } from '@uiw/codemirror-theme-gruvbox-dark';
import { monokai } from '@uiw/codemirror-theme-monokai';
import { nord } from '@uiw/codemirror-theme-nord';
import { quietlight } from '@uiw/codemirror-theme-quietlight';
import { tokyoNight } from '@uiw/codemirror-theme-tokyo-night';
import { vscodeDark, vscodeLight } from '@uiw/codemirror-theme-vscode';
import { xcodeLight } from '@uiw/codemirror-theme-xcode';

/** All valid editor theme identifiers. */
export type EditorThemeId =
  | 'github-light'
  | 'xcode-light'
  | 'eclipse'
  | 'quietlight'
  | 'vscode-light'
  | 'dracula'
  | 'tokyo-night'
  | 'nord'
  | 'monokai'
  | 'github-dark'
  | 'atomone'
  | 'vscode-dark'
  | 'gruvbox-dark';

export type ThemeVariant = 'light' | 'dark';

export type ThemeConfig = {
  readonly id: EditorThemeId;
  readonly label: string;
  readonly variant: ThemeVariant;
  /** Background colour for the swatch preview */
  readonly bg: string;
  /** Foreground / text colour for the swatch preview */
  readonly fg: string;
  readonly extension: Extension;
};

export const themes: readonly ThemeConfig[] = [
  // ── Light ──────────────────────────────────────────────────────────────────
  { id: 'github-light', label: 'GitHub Light', variant: 'light', bg: '#ffffff', fg: '#24292e', extension: githubLight },
  { id: 'xcode-light',  label: 'Xcode Light',  variant: 'light', bg: '#ffffff', fg: '#000000', extension: xcodeLight },
  { id: 'eclipse',      label: 'Eclipse',       variant: 'light', bg: '#ffffff', fg: '#000000', extension: eclipse },
  { id: 'quietlight',   label: 'Quiet Light',   variant: 'light', bg: '#f5f5f5', fg: '#333333', extension: quietlight },
  { id: 'vscode-light', label: 'VS Code Light', variant: 'light', bg: '#ffffff', fg: '#000000', extension: vscodeLight },
  // ── Dark ───────────────────────────────────────────────────────────────────
  { id: 'github-dark',  label: 'GitHub Dark',   variant: 'dark',  bg: '#0d1117', fg: '#c9d1d9', extension: githubDark },
  { id: 'dracula',      label: 'Dracula',        variant: 'dark',  bg: '#282a36', fg: '#f8f8f2', extension: dracula },
  { id: 'tokyo-night',  label: 'Tokyo Night',    variant: 'dark',  bg: '#1a1b26', fg: '#a9b1d6', extension: tokyoNight },
  { id: 'nord',         label: 'Nord',           variant: 'dark',  bg: '#2e3440', fg: '#d8dee9', extension: nord },
  { id: 'monokai',      label: 'Monokai',        variant: 'dark',  bg: '#272822', fg: '#f8f8f2', extension: monokai },
  { id: 'atomone',      label: 'Atom One',       variant: 'dark',  bg: '#282c34', fg: '#abb2bf', extension: atomone },
  { id: 'vscode-dark',  label: 'VS Code Dark',   variant: 'dark',  bg: '#1e1e1e', fg: '#d4d4d4', extension: vscodeDark },
  { id: 'gruvbox-dark', label: 'Gruvbox Dark',   variant: 'dark',  bg: '#282828', fg: '#ebdbb2', extension: gruvboxDark },
] as const;

export const themeMap = new Map<EditorThemeId, ThemeConfig>(
  themes.map((t) => [t.id, t]),
);

/**
 * Returns the `ThemeConfig` for the given ID, falling back to `github-dark`
 * if the ID is not found.
 */
export function getTheme(id: EditorThemeId): ThemeConfig {
  return themeMap.get(id) ?? (themes.find((t) => t.id === 'github-dark') as ThemeConfig);
}
