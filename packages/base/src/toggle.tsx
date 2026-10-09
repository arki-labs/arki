'use client';

import type { VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { Toggle as TogglePrimitive } from '@base-ui/react/toggle';
import { cva } from 'class-variance-authority';

import { cn } from './cn';

const toggleVariants = cva(
  "outline-ring/50 ring-ring/10 hover:bg-muted hover:text-muted-foreground aria-pressed:bg-accent aria-pressed:text-accent-foreground dark:outline-ring/40 dark:ring-ring/20 inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-[color,box-shadow] transition-colors focus-visible:ring-4 focus-visible:outline-1 disabled:pointer-events-none disabled:opacity-50 aria-invalid:focus-visible:ring-0 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-transparent',
        outline: 'border-input hover:bg-accent hover:text-accent-foreground border bg-transparent shadow-xs',
      },
      size: {
        default: 'h-9 min-w-9 px-2',
        sm: 'h-8 min-w-8 px-1.5',
        lg: 'h-10 min-w-10 px-2.5',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

function Toggle({
  className,
  variant,
  size,
  ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive data-slot="toggle" className={cn(toggleVariants({ variant, size, className }))} {...props} />
  );
}

export { Toggle, toggleVariants };
