import type { ComponentProps } from 'react';

import { cn } from './cn';

export type SurfaceProps = ComponentProps<'div'> & {
  withShadow?: boolean;
  withBorder?: boolean;
};

export function Surface({ children, className, withShadow = true, withBorder = true, ...props }: SurfaceProps) {
  const surfaceClass = cn(
    'rounded-lg bg-white dark:bg-black',
    withShadow ? 'shadow-xs' : '',
    withBorder ? 'border border-neutral-200 dark:border-neutral-800' : '',
    className,
  );

  return (
    <div className={surfaceClass} {...props}>
      {children}
    </div>
  );
}

Surface.displayName = 'Surface';
