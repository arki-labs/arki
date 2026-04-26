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
      info: 'border-blue-200 bg-blue-100/50 text-blue-800 dark:border-blue-800 dark:bg-blue-900/50 dark:text-blue-200',
      warning:
        'border-yellow-200 bg-yellow-100/50 text-yellow-800 dark:border-yellow-800 dark:bg-yellow-900/50 dark:text-yellow-200',
      success:
        'border-green-200 bg-green-100/50 text-green-800 dark:border-green-800 dark:bg-green-900/50 dark:text-green-200',
      error: 'border-red-200 bg-red-100/50 text-red-800 dark:border-red-800 dark:bg-red-900/50 dark:text-red-200',
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
