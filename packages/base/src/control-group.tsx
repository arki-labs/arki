import * as React from 'react';
import { cn } from './cn';
import { Slot } from './slot';

const ControlGroupContext = React.createContext<Pick<ControlGroupProps, 'orientation'>>({
  orientation: 'horizontal',
});

function useControlGroupContext() {
  const context = React.useContext(ControlGroupContext);

  if (!context) {
    throw new Error('useControlGroup must be used within a <ControlGroup />');
  }

  return context;
}

export type ControlGroupProps = {
  orientation?: 'horizontal' | 'vertical';
} & React.ComponentPropsWithoutRef<'div'>

export const ControlGroup = React.forwardRef<HTMLDivElement, ControlGroupProps>(
  ({ className, orientation = 'horizontal', ...props }, ref) => (
    <ControlGroupContext.Provider value={{ orientation }}>
      <div
        ref={ref}
        data-orientation={orientation}
        className={cn('flex', orientation === 'vertical' && 'flex-col', className)}
        {...props}
      />
    </ControlGroupContext.Provider>
  ),
);
ControlGroup.displayName = 'ControlGroup';

export const ControlGroupItem = React.forwardRef<
  HTMLElement,
  React.HTMLAttributes<HTMLElement> & { children?: React.ReactNode }
>(({ className, ...props }, ref) => {
  const { orientation } = useControlGroupContext();

  return (
    <Slot
      ref={ref}
      className={cn(
        'rounded-none focus-within:z-10',
        orientation === 'horizontal' && '-me-px h-auto first:rounded-s-md last:-me-0 last:rounded-e-md',
        orientation === 'vertical' &&
          'w-auto [margin-block-end:-1px] first:rounded-ss-md first:rounded-se-md last:rounded-ee-md last:rounded-es-md last:[margin-block-end:0]',
        className,
      )}
      {...props}
    />
  );
});
ControlGroupItem.displayName = 'ControlGroupItem';
