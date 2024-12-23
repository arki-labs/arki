import type { ComponentProps } from 'react';

import { cn } from './cn';

export { PulseLoader } from 'react-spinners';

export function Spinner({ className, ...rest }: ComponentProps<'div'>) {
  const spinnerClass = cn('h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent', className);

  return <div className={spinnerClass} {...rest} />;
}

Spinner.displayName = 'Spinner';
