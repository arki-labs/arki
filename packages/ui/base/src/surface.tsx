import type { HTMLProps } from 'react';
import { forwardRef } from 'react';

import { cn } from './cn';

export type SurfaceProps = HTMLProps<HTMLDivElement> & {
  withShadow?: boolean;
  withBorder?: boolean;
};

export const Surface = forwardRef<HTMLDivElement, SurfaceProps>(
  ({ children, className, withShadow = true, withBorder = true, ...props }, ref) => {
    const surfaceClass = cn(
      'rounded-lg bg-white dark:bg-black',
      withShadow ? 'shadow-sm' : '',
      withBorder ? 'border border-neutral-200 dark:border-neutral-800' : '',
      className,
    );

    return (
      <div className={surfaceClass} {...props} ref={ref}>
        {children}
      </div>
    );
  },
);

Surface.displayName = 'Surface';
