'use client';

import type { FC } from 'react';
import * as React from 'react';
import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip';

import { withAsChild, type AsChildProp } from './as-child';
import { cn } from './cn';

function TooltipProvider({
  delay = 0,
  // Radix-era alias kept for backwards compat — Base UI renamed to `delay`.
  delayDuration,
  ...props
}: TooltipPrimitive.Provider.Props & { delayDuration?: number }) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delay={delayDuration ?? delay}
      {...props}
    />
  );
}

function Tooltip({ ...props }: TooltipPrimitive.Root.Props) {
  return (
    <TooltipProvider>
      <TooltipPrimitive.Root data-slot="tooltip" {...props} />
    </TooltipProvider>
  );
}

function TooltipTrigger({
  asChild,
  children,
  ...props
}: TooltipPrimitive.Trigger.Props & AsChildProp) {
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      {...props}
      {...withAsChild({ asChild, children })}
    />
  );
}

function TooltipContent({
  className,
  sideOffset = 4,
  side = 'top',
  align = 'center',
  alignOffset = 0,
  children,
  ...props
}: TooltipPrimitive.Popup.Props & Pick<TooltipPrimitive.Positioner.Props, 'side' | 'sideOffset' | 'align' | 'alignOffset'>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner side={side} sideOffset={sideOffset} align={align} alignOffset={alignOffset} className="isolate z-50">
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            'bg-primary text-primary-foreground z-50 max-w-sm rounded-md px-3 py-1.5 text-xs origin-(--transform-origin) data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
            className,
          )}
          {...props}
        >
          {children}
          <TooltipPrimitive.Arrow
            className={cn(
              'bg-primary fill-primary z-50 size-2.5 rotate-45 rounded-[2px]',
              'data-[side=bottom]:top-[-5px]',
              'data-[side=top]:bottom-[-5px]',
              'data-[side=left]:right-[-5px]',
              'data-[side=right]:left-[-5px]',
            )}
          />
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

type WithTooltipProps = {
  content: React.ReactNode;
  trigger: React.ReactNode;
  delayDuration?: number;
  side?: 'left' | 'right' | 'top' | 'bottom';
};

const WithTooltip: FC<WithTooltipProps> = ({ content, trigger, delayDuration = 700, side = 'right' }) => {
  // Base UI's TooltipTrigger uses `render` instead of `asChild`.
  // When trigger is a React element, use it as the render target so the tooltip
  // attaches to the element directly rather than wrapping it in a button.
  if (React.isValidElement(trigger)) {
    const triggerEl = trigger as React.ReactElement<{ children?: React.ReactNode }>;
    return (
      <TooltipProvider delay={delayDuration}>
        <Tooltip>
          <TooltipTrigger render={triggerEl as React.ReactElement}>
            {triggerEl.props.children}
          </TooltipTrigger>
          <TooltipContent side={side}>{content}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delay={delayDuration}>
      <Tooltip>
        <TooltipTrigger>{trigger}</TooltipTrigger>
        <TooltipContent side={side}>{content}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, WithTooltip };
