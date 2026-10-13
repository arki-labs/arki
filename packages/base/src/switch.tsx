'use client';

import * as React from 'react';
import { Switch as SwitchPrimitive } from '@base-ui/react/switch';

import { cn } from './cn';

function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'peer outline-ring/50 ring-ring/10 data-checked:bg-primary data-unchecked:bg-input dark:outline-ring/40 dark:ring-ring/20 inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent shadow-xs transition-[color,box-shadow] focus-visible:ring-4 focus-visible:outline-hidden focus-visible:outline-1 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:focus-visible:ring-0',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          'bg-background pointer-events-none block size-4 rounded-full ring-0 shadow-lg transition-transform data-checked:translate-x-4 data-unchecked:translate-x-0',
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
