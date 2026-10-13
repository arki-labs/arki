'use client';

import { PreviewCard as PreviewCardPrimitive } from '@base-ui/react/preview-card';

import type { AsChildProp } from './as-child';
import { withAsChild } from './as-child';
import { cn } from './cn';

function HoverCard({
  // Radix-era props that Base UI moved to PreviewCardTrigger. Accepted and
  // dropped at the Root level so consumer code typechecks; the values aren't
  // honored without rewriting call sites to put them on the Trigger.

  openDelay: _openDelay,

  closeDelay: _closeDelay,
  ...props
}: PreviewCardPrimitive.Root.Props & { openDelay?: number; closeDelay?: number }) {
  return <PreviewCardPrimitive.Root data-slot="hover-card" {...props} />;
}

function HoverCardTrigger({ asChild, children, ...props }: PreviewCardPrimitive.Trigger.Props & AsChildProp) {
  return (
    <PreviewCardPrimitive.Trigger data-slot="hover-card-trigger" {...props} {...withAsChild({ asChild, children })} />
  );
}

function HoverCardContent({
  className,
  align = 'center',
  alignOffset = 4,
  side = 'bottom',
  sideOffset = 4,
  ...props
}: PreviewCardPrimitive.Popup.Props &
  Pick<PreviewCardPrimitive.Positioner.Props, 'align' | 'alignOffset' | 'side' | 'sideOffset'>) {
  return (
    <PreviewCardPrimitive.Portal>
      <PreviewCardPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-50"
      >
        <PreviewCardPrimitive.Popup
          data-slot="hover-card-content"
          className={cn(
            'origin-(--transform-origin) outline-hidden data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 z-50 w-64 rounded-md border bg-popover p-4 text-popover-foreground shadow-md duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
            className,
          )}
          {...props}
        />
      </PreviewCardPrimitive.Positioner>
    </PreviewCardPrimitive.Portal>
  );
}

export { HoverCard, HoverCardContent, HoverCardTrigger };
