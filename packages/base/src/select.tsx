'use client';

import * as React from 'react';
import { Select as SelectPrimitive } from '@base-ui/react/select';

import { CaretDownIcon, CaretUpIcon, CheckIcon } from '@arki/icons/phosphor';

import { cn } from './cn';

type SelectProps<Value extends string = string> = Omit<
  React.ComponentProps<typeof SelectPrimitive.Root>,
  'onValueChange' | 'value' | 'defaultValue'
> & {
  value?: Value;
  defaultValue?: Value;
  onValueChange?: (value: Value) => void;
};

function Select<Value extends string = string>({ onValueChange, ...props }: SelectProps<Value>) {
  return (
    <SelectPrimitive.Root
      data-slot="select"
      onValueChange={onValueChange ? value => onValueChange(value as Value) : undefined}
      {...props}
    />
  );
}

function SelectGroup({ ...props }: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

function SelectValue({ ...props }: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

function SelectTrigger({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        "aria-invalid:border-destructive data-placeholder:text-muted-foreground shadow-xs aria-invalid:focus-visible:ring-0 flex h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-ring/50 ring-ring/10 transition-[color,box-shadow] focus-visible:outline-1 focus-visible:ring-4 disabled:cursor-not-allowed disabled:opacity-50 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2 dark:outline-ring/40 dark:ring-ring/20 [&>span]:line-clamp-1 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className,
      )}
      {...props}
    >
      {children}
      <CaretDownIcon className="size-4 shrink-0 opacity-50" weight="regular" />
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  className,
  children,
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Positioner> & {
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner sideOffset={sideOffset} className="isolate z-50" {...props}>
        <SelectPrimitive.Popup
          data-slot="select-content"
          className={cn(
            'data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 relative flex max-h-96 min-w-[8rem] flex-col overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
            className,
          )}
        >
          <SelectScrollUpButton />
          <div className="w-full min-w-[var(--select-trigger-width)] flex-1 scroll-my-1 overflow-auto p-1">
            {children}
          </div>
          <SelectScrollDownButton />
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

function SelectLabel({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.GroupLabel>) {
  return (
    <SelectPrimitive.GroupLabel
      data-slot="select-label"
      className={cn('px-2 py-1.5 text-sm font-semibold', className)}
      {...props}
    />
  );
}

function SelectItem({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "data-highlighted:bg-accent data-highlighted:text-accent-foreground rounded-xs outline-hidden data-disabled:pointer-events-none data-disabled:opacity-50 relative flex w-full cursor-default select-none items-center gap-2 py-1.5 pl-2 pr-8 text-sm [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className,
      )}
      {...props}
    >
      <span className="absolute right-2 flex size-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="size-4" weight="regular" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

function SelectSeparator({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn('pointer-events-none -mx-1 my-1 h-px bg-border', className)}
      {...props}
    />
  );
}

function SelectScrollUpButton({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.ScrollUpArrow>) {
  return (
    <SelectPrimitive.ScrollUpArrow
      data-slot="select-scroll-up-button"
      className={cn('flex cursor-default items-center justify-center py-1', className)}
      {...props}
    >
      <CaretUpIcon className="size-4" weight="regular" />
    </SelectPrimitive.ScrollUpArrow>
  );
}

function SelectScrollDownButton({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.ScrollDownArrow>) {
  return (
    <SelectPrimitive.ScrollDownArrow
      data-slot="select-scroll-down-button"
      className={cn('flex cursor-default items-center justify-center py-1', className)}
      {...props}
    >
      <CaretDownIcon className="size-4" weight="regular" />
    </SelectPrimitive.ScrollDownArrow>
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
