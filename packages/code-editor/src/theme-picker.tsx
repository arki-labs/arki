'use client';

import { PaletteIcon } from '@arki/icons/phosphor';
import { cn } from '@arki/ui/cn';
import { Popover, PopoverContent, PopoverTrigger } from '@arki/ui/popover';

import type { EditorThemeId, ThemeConfig } from './themes';
import { themes } from './themes';

const lightThemes = themes.filter((t) => t.variant === 'light');
const darkThemes = themes.filter((t) => t.variant === 'dark');

export function ThemeSwatch({
  config,
  selected,
  onSelect,
}: {
  config: ThemeConfig;
  selected: boolean;
  onSelect: (id: EditorThemeId) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(config.id)}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-xs transition-colors',
        selected
          ? 'bg-accent text-accent-foreground font-medium'
          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
      )}
      title={config.label}
    >
      <span
        className="inline-block h-3.5 w-5 shrink-0 rounded-sm border border-black/10"
        style={{ backgroundColor: config.bg }}
      />
      <span className="flex-1 text-left leading-none">{config.label}</span>
      {selected && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-primary" />}
    </button>
  );
}

export function ThemeGroup({
  label,
  items,
  selected,
  onSelect,
}: {
  label: string;
  items: readonly ThemeConfig[];
  selected: EditorThemeId;
  onSelect: (id: EditorThemeId) => void;
}) {
  return (
    <div>
      <p className="mb-1 px-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
        {label}
      </p>
      {items.map((t) => (
        <ThemeSwatch key={t.id} config={t} selected={selected === t.id} onSelect={onSelect} />
      ))}
    </div>
  );
}

/**
 * Compact palette button that opens a popover for selecting the code editor
 * theme. Controlled via `value` / `onChange` — the consuming app reads/writes
 * its own `editorThemeAtom` and connects it here.
 */
export function ThemePicker({
  value,
  onChange,
  className,
}: {
  value: EditorThemeId;
  onChange: (id: EditorThemeId) => void;
  className?: string;
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            title="Code editor theme"
            className={cn(
              'flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-accent/50',
              className,
            )}
          />
        }
      >
        <PaletteIcon className="h-4 w-4" />
        <span className="sr-only">Code editor theme</span>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={8} className="w-52 p-2">
        <p className="mb-2 px-1 text-xs font-semibold text-foreground">Code Theme</p>
        <div className="space-y-3">
          <ThemeGroup label="Light" items={lightThemes} selected={value} onSelect={onChange} />
          <ThemeGroup label="Dark" items={darkThemes} selected={value} onSelect={onChange} />
        </div>
      </PopoverContent>
    </Popover>
  );
}
