/** Skeleton: a grey placeholder while content loads. */
import { cn } from './cn';

function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      className={cn('bg-primary/10 motion-safe:animate-pulse rounded-md', className)}
      {...props}
    />
  );
}

export { Skeleton };
