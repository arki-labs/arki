'use client';

import React from 'react';

import { Button } from '@arki/base-ui/button';
import { cn } from '@arki/base-ui/cn';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@arki/base-ui/dropdown-menu';
import { WithTooltip } from '@arki/base-ui/tooltip';
import { CloudMoon, Moon, Sun } from '@arki/icons';
import { useTheme } from '@arki/theme';

export function ThemeSelect() {
  const { setTheme } = useTheme();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-12 w-12 px-2">
          <Sun className="size-6 scale-100 rotate-0 transition-all dark:scale-0 dark:rotate-90" />
          <Moon className="absolute size-6 scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-20">
        <DropdownMenuItem onClick={() => setTheme('light')}>
          <Sun className="mr-2 h-4 w-4" />
          <span>Light</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('dark')}>
          <Moon className="mr-2 h-4 w-4" />
          <span>Dark</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('system')}>
          <CloudMoon className="mr-2 h-4 w-4" />
          <span>System</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ThemeToggle({
  tooltipProps,
  className,
}: {
  tooltipProps?: Omit<React.ComponentProps<typeof WithTooltip>, 'trigger' | 'content'>;
  className?: string;
}) {
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <WithTooltip
      delayDuration={500}
      trigger={
        <Button
          variant="ghost"
          className={cn('size-8 px-2', className)}
          onClick={() => {
            setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
          }}
        >
          <Sun className="size-6 scale-100 rotate-0 transition-all dark:scale-0 dark:rotate-90" />
          <Moon className="absolute size-6 scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
        </Button>
      }
      content={<p>{resolvedTheme === 'light' ? 'Turn off' : 'Turn on'} the light</p>}
      {...tooltipProps}
    />
  );
}

export function ThemeSwitcher({
  className,
  buttonProps,
  dropdownProps,
}: Readonly<{
  className?: string;
  buttonProps?: React.ComponentProps<typeof Button>;
  dropdownProps?: React.ComponentProps<typeof DropdownMenuContent>;
}>) {
  const { setTheme } = useTheme();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button data-slot="theme-switcher" variant="ghost" className={className} {...buttonProps}>
          <Sun className="size-6 scale-100 rotate-0 transition-all dark:scale-0 dark:rotate-90" />
          <Moon className="absolute size-6 scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
          <span className="sr-only">Toggle theme</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="right" {...dropdownProps}>
        <DropdownMenuItem onClick={() => setTheme('light')}>Light</DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('dark')}>Dark</DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('system')}>System</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
