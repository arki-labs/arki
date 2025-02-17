'use client';

import React from 'react';
import { LuCloudMoon, LuMoon, LuSun } from 'react-icons/lu';

import { Button } from '@arki/base-ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@arki/base-ui/dropdown-menu';
import { Surface } from '@arki/base-ui/surface';
import { Toolbar } from '@arki/base-ui/toolbar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@arki/base-ui/tooltip';
import { useTheme } from '@arki/theme';

export function ThemeSelect() {
  const { resolvedTheme, setTheme } = useTheme();

  const [hasMounted, setHasMounted] = React.useState(false);
  React.useEffect(() => {
    setHasMounted(true);
  }, []);

  if (!hasMounted) {
    return null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-12 w-12 px-2">
          {resolvedTheme === 'dark' ? <LuMoon className="h-8 w-8" /> : <LuSun className="h-8 w-8" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-20">
        <DropdownMenuItem onClick={() => setTheme('light')}>
          <LuSun className="mr-2 h-4 w-4" />
          <span>Light</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('dark')}>
          <LuMoon className="mr-2 h-4 w-4" />
          <span>Dark</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('system')}>
          <LuCloudMoon className="mr-2 h-4 w-4" />
          <span>System</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <Tooltip delayDuration={500}>
      <TooltipTrigger
        className="mr-1 h-10 w-10 px-2 opacity-30 transition-opacity hover:bg-inherit hover:opacity-100"
        onClick={() => {
          setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
        }}
      >
        {resolvedTheme === 'light' ? <LuMoon className="h-6 w-6" /> : <LuSun className="h-6 w-6" />}
      </TooltipTrigger>
      <TooltipContent>
        <p>{resolvedTheme === 'light' ? 'Turn off' : 'Turn on'} the light</p>
      </TooltipContent>
    </Tooltip>
  );
}

export function ThemeSwitchToolbar() {
  const { resolvedTheme, setTheme } = useTheme();

  const [hasMounted, setHasMounted] = React.useState(false);
  React.useEffect(() => {
    setHasMounted(true);
  }, []);

  if (!hasMounted) {
    return null;
  }

  return (
    <Surface className="fixed right-6 bottom-6 z-[99999] flex items-center gap-1 p-1">
      <Toolbar.Button onClick={() => setTheme('light')} active={resolvedTheme === 'light'}>
        <LuSun className="h-6 w-6" />
      </Toolbar.Button>
      <Toolbar.Button onClick={() => setTheme('dark')} active={resolvedTheme === 'dark'}>
        <LuMoon className="h-6 w-6" />
      </Toolbar.Button>
    </Surface>
  );
}

export function ThemeSwitcher({ className }: Readonly<{ className?: string }>) {
  const { setTheme } = useTheme();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button data-slot="theme-switcher" variant="ghost" size="icon" className={className}>
          <LuSun className="h-[1.2rem] w-[1.2rem] scale-100 rotate-0 transition-all dark:scale-0 dark:rotate-90" />
          <LuMoon className="absolute h-[1.2rem] w-[1.2rem] scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
          <span className="sr-only">Toggle theme</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setTheme('light')}>Light</DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('dark')}>Dark</DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('system')}>System</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
