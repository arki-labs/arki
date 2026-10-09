import type { VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { cva } from 'class-variance-authority';

import { cn } from './cn';
import { Slot } from './slot';

const buttonVariants = cva(
  "outline-ring/50 ring-ring/10 dark:outline-ring/40 dark:ring-ring/20 inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-[color,box-shadow] focus:outline-hidden focus-visible:ring focus-visible:ring-4 focus-visible:ring-blue-500/75 focus-visible:outline-1 disabled:pointer-events-none disabled:opacity-50 aria-invalid:focus-visible:ring-0 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90 shadow-xs',
        primary: 'bg-primary text-primary-foreground hover:bg-primary/90 shadow-xs',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90 shadow-xs',
        outline: 'hover:bg-accent hover:text-accent-foreground bg-background/10 border-input border shadow-xs',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80 shadow-xs',
        tertiary: 'bg-tertiary text-tertiary-foreground hover:bg-tertiary/80 shadow-xs',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
        text: 'text-muted-foreground underline-offset-4 hover:underline focus:underline-offset-8 focus:ring-0 focus:ring-offset-0',
      },
      size: {
        default: 'h-9 px-4 py-2 has-[>svg]:px-3',
        xs: 'h-6 rounded-sm px-2 py-1 has-[>svg]:px-1.5',
        sm: 'h-8 rounded-md px-3 has-[>svg]:px-2.5',
        md: 'h-9 rounded-md px-4 has-[>svg]:px-3',
        lg: 'h-10 rounded-md px-6 has-[>svg]:px-4',
        icon: 'size-9',
        iconSm: 'size-6',
        iconMd: 'size-9',
        iconLg: 'size-10',
        iconXl: 'size-12',
        icon2xl: 'size-14',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

type ButtonProps = React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  };

function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const buttonClass = cn(buttonVariants({ variant, size, className }));

  // When asChild is true, use our Slot to merge button styles into the child element
  // (e.g. a Next.js <Link>), equivalent to Radix's asChild/Slot pattern.
  if (asChild) {
    return <Slot data-slot="button" className={buttonClass} {...props} />;
  }

  return <ButtonPrimitive data-slot="button" className={buttonClass} {...props} />;
}

export { Button, buttonVariants, type ButtonProps };
