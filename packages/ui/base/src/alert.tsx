import type { VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cva } from 'class-variance-authority';

import { cn } from './cn';

const alertVariants = cva(
  'relative w-full rounded-lg border px-4 py-3 text-sm [&>svg+div]:translate-y-[-3px] [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg]:text-foreground [&>svg~*]:pl-7',
  {
    variants: {
      variant: {
        default: 'bg-background text-foreground',
        destructive: 'border-destructive/50 text-destructive dark:border-destructive [&>svg]:text-destructive',
        secondary: 'border-secondary/50 text-secondary dark:border-secondary [&>svg]:text-secondary',
        outline: 'border-input/50 text-foreground dark:border-input [&>svg]:text-foreground',
        warning:
          'border-shadow-yellow-600/10 dark:border-shadow-yellow-400/10 border-yellow-600 bg-yellow-50 text-yellow-600 dark:border-yellow-600/50 dark:bg-yellow-600/50 dark:text-yellow-400 [&>svg]:text-yellow-600',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function Alert({ className, variant, ...props }: ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return <div role="alert" className={cn(alertVariants({ variant }), className)} {...props} />;
}
Alert.displayName = 'Alert';

function AlertTitle({ className, ...props }: ComponentProps<'h5'>) {
  return <h5 className={cn('mb-1 font-medium leading-none tracking-tight', className)} {...props} />;
}

AlertTitle.displayName = 'AlertTitle';

function AlertDescription({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('text-sm [&_p]:leading-relaxed', className)} {...props} />;
}
AlertDescription.displayName = 'AlertDescription';

export { Alert, AlertTitle, AlertDescription };
