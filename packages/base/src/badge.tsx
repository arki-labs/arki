import type { VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cva } from 'class-variance-authority';

import { cn } from './cn';
import { Slot } from './slot';

const badgeVariants = cva(
  'outline-ring/50 ring-ring/10 dark:outline-ring/40 dark:ring-ring/20 inline-flex w-fit shrink-0 items-center justify-center gap-1 rounded-md border px-2 py-0.5 text-xs font-semibold whitespace-nowrap transition-[color,box-shadow] focus-visible:ring-4 focus-visible:outline-1 aria-invalid:focus-visible:ring-0 [&>svg]:pointer-events-none [&>svg]:size-3',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground [a&]:hover:bg-primary/90 border-transparent shadow-xs',
        secondary: 'bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90 border-transparent',
        destructive:
          'bg-destructive text-destructive-foreground [a&]:hover:bg-destructive/90 border-transparent shadow-xs',
        outline: 'text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'span';

  return <Comp data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
