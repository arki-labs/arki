import type { VariantProps } from 'class-variance-authority';
import { cva } from 'class-variance-authority';

import { Check, Info, Siren, Warning } from '@arki/icons/phosphor';

import { cn } from './cn';

function getIcon(variant: CalloutProps['variant']) {
  switch (variant) {
    case 'warning': {
      return Warning;
    }
    case 'success': {
      return Check;
    }
    case 'error': {
      return Siren;
    }
    default: {
      return Info;
    }
  }
}

const calloutVariants = cva('flex rounded-md border px-3 py-2', {
  variants: {
    variant: {
      info: 'border-info/40 bg-info-surface [&>svg]:text-info text-foreground',
      warning: 'border-warning/40 bg-warning-surface [&>svg]:text-warning text-foreground',
      success: 'border-success/40 bg-success-surface [&>svg]:text-success text-foreground',
      error: 'bg-destructive-surface border-destructive/40 text-foreground [&>svg]:text-destructive',
    },
  },
  defaultVariants: {
    variant: 'info',
  },
});

export type CalloutProps = {} & React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof calloutVariants>;

export function Callout({ variant, children, className, ...props }: CalloutProps) {
  const Icon = getIcon(variant);
  return (
    <div className={cn(calloutVariants({ variant, className }))} {...props}>
      <Icon className="my-1.5 mr-2 h-4 w-4 shrink-0" />
      <div>{children}</div>
    </div>
  );
}
