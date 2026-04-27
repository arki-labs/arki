'use client';

import * as React from 'react';
import { Slider as SliderPrimitive } from '@base-ui/react/slider';

import { cn } from './cn';

type SliderProps = Omit<
  SliderPrimitive.Root.Props,
  'onValueChange' | 'onValueCommitted'
> & {
  onValueChange?: (value: number[]) => void;
  /** Fires after the user finishes a drag/keyboard interaction. */
  onValueCommitted?: (value: number[]) => void;
  /** Radix-era alias for `onValueCommitted` — accepted for backwards compat. */
  onValueCommit?: (value: number[]) => void;
};

function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  onValueChange,
  onValueCommitted,
  onValueCommit,
  ...props
}: SliderProps) {
  const _values = React.useMemo(
    () => (Array.isArray(value) ? value : (Array.isArray(defaultValue) ? defaultValue : [min, max])),
    [value, defaultValue, min, max],
  );
  const handleCommit = onValueCommitted ?? onValueCommit;

  return (
    <SliderPrimitive.Root
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      thumbAlignment="edge"
      className={cn('relative flex w-full touch-none select-none data-disabled:opacity-50 data-vertical:h-full', className)}
      onValueChange={onValueChange ? (v) => onValueChange(Array.isArray(v) ? [...v] : [v]) : undefined}
      onValueCommitted={handleCommit ? (v) => handleCommit(Array.isArray(v) ? [...v] : [v]) : undefined}
      {...props}
    >
      <SliderPrimitive.Control className="relative flex w-full touch-none items-center select-none data-disabled:opacity-50 data-vertical:h-full data-vertical:min-h-44 data-vertical:w-auto data-vertical:flex-col">
        <SliderPrimitive.Track
          data-slot="slider-track"
          className="relative grow overflow-hidden rounded-full bg-muted data-horizontal:h-1.5 data-horizontal:w-full data-vertical:h-full data-vertical:w-1.5"
        >
          <SliderPrimitive.Indicator
            data-slot="slider-range"
            className="bg-primary data-horizontal:h-full data-vertical:w-full"
          />
        </SliderPrimitive.Track>
        {Array.from({ length: _values.length }, (_, index) => (
          <SliderPrimitive.Thumb
            data-slot="slider-thumb"
            key={index}
            className="border-primary bg-background ring-ring/20 block size-4 shrink-0 rounded-full border shadow-xs transition-[color,box-shadow] hover:ring-4 focus-visible:ring-4 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50"
          />
        ))}
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

export { Slider };
