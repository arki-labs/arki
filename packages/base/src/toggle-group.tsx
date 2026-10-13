'use client';

import type { VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { Toggle as TogglePrimitive } from '@base-ui/react/toggle';
import { ToggleGroup as ToggleGroupPrimitive } from '@base-ui/react/toggle-group';

import { cn } from './cn';
import { toggleVariants } from './toggle';

const ToggleGroupContext = React.createContext<VariantProps<typeof toggleVariants>>({
  size: 'default',
  variant: 'default',
});

type ToggleGroupCompatProps = Omit<ToggleGroupPrimitive.Props, 'value' | 'defaultValue' | 'onValueChange'> &
  VariantProps<typeof toggleVariants> & {
    /** Radix-era prop: 'single' (one selection) or 'multiple' (many). Maps to Base UI `multiple`. */
    type?: 'single' | 'multiple';
    /** Radix-shape value: a single string in `single` mode, an array in `multiple` mode. */
    value?: string | readonly string[];
    defaultValue?: string | readonly string[];
    /** Radix-shape callback: receives a string in `single` mode, an array in `multiple` mode. */
    onValueChange?: (value: string & string[]) => void;
  };

function ToggleGroup({
  className,
  variant,
  size,
  children,
  type,
  value,
  defaultValue,
  onValueChange,
  ...props
}: ToggleGroupCompatProps) {
  // Translate Radix `type` → Base UI `multiple`, and normalize Radix's
  // string-or-array value/callback shape to Base UI's always-array shape.
  const multiple = type === 'multiple' ? true : props.multiple;
  const normalizedValue = value === undefined ? undefined : Array.isArray(value) ? value : [value as string];
  const normalizedDefault =
    defaultValue === undefined ? undefined : Array.isArray(defaultValue) ? defaultValue : [defaultValue as string];
  const handleValueChange = onValueChange
    ? (groupValue: string[]) => {
        if (multiple) {
          (onValueChange as unknown as (v: string[]) => void)(groupValue);
        } else {
          (onValueChange as unknown as (v: string) => void)(groupValue[0] ?? '');
        }
      }
    : undefined;

  return (
    <ToggleGroupPrimitive
      data-slot="toggle-group"
      data-variant={variant}
      data-size={size}
      className={cn(
        'group/toggle-group data-[variant=outline]:shadow-xs flex items-center justify-center rounded-md',
        className,
      )}
      {...props}
      multiple={multiple}
      value={normalizedValue}
      defaultValue={normalizedDefault}
      onValueChange={handleValueChange}
    >
      <ToggleGroupContext.Provider value={{ variant, size }}>{children}</ToggleGroupContext.Provider>
    </ToggleGroupPrimitive>
  );
}

function ToggleGroupItem({
  className,
  children,
  variant,
  size,
  ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  const context = React.useContext(ToggleGroupContext);

  return (
    <TogglePrimitive
      data-slot="toggle-group-item"
      data-variant={context.variant || variant}
      data-size={context.size || size}
      className={cn(
        toggleVariants({
          variant: context.variant || variant,
          size: context.size || size,
        }),
        'min-w-0 shrink-0 rounded-none shadow-none first:rounded-l-md last:rounded-r-md focus:z-10 focus-visible:z-10 data-[variant=outline]:border-l-0 data-[variant=outline]:first:border-l',
        className,
      )}
      {...props}
    >
      {children}
    </TogglePrimitive>
  );
}

export { ToggleGroup, ToggleGroupItem };
