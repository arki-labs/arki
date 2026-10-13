'use client';

import { Accordion as AccordionPrimitive } from '@base-ui/react/accordion';

import { CaretDownIcon, CaretUpIcon } from '@arki/icons/phosphor';

import { cn } from './cn';

type AccordionCompatProps = Omit<AccordionPrimitive.Root.Props, 'value' | 'defaultValue' | 'onValueChange'> & {
  /** Radix-era prop: 'single' or 'multiple'. Maps to Base UI `multiple`. */
  type?: 'single' | 'multiple';
  /** Radix-era prop: allow collapsing the only-open item. Base UI default already allows this. */
  collapsible?: boolean;
  /** Radix-shape value: a single string in `single` mode, an array in `multiple` mode. */
  value?: string | readonly string[];
  defaultValue?: string | readonly string[];
  onValueChange?: (value: string & string[]) => void;
};

function Accordion({
  type,
  collapsible: _collapsible,
  value,
  defaultValue,
  onValueChange,
  ...props
}: AccordionCompatProps) {
  // Translate Radix `type` → Base UI `multiple`. `collapsible` is the
  // Base UI default so it's accepted-and-ignored for backwards compat.
  const multiple = type === 'multiple' ? true : props.multiple;
  const normalizedValue = value === undefined ? undefined : Array.isArray(value) ? value : [value as string];
  const normalizedDefault =
    defaultValue === undefined ? undefined : Array.isArray(defaultValue) ? defaultValue : [defaultValue as string];
  const handleValueChange = onValueChange
    ? (groupValue: unknown[]) => {
        if (multiple) {
          (onValueChange as unknown as (v: unknown[]) => void)(groupValue);
        } else {
          (onValueChange as unknown as (v: unknown) => void)(groupValue[0] ?? '');
        }
      }
    : undefined;
  return (
    <AccordionPrimitive.Root
      data-slot="accordion"
      {...props}
      multiple={multiple}
      value={normalizedValue}
      defaultValue={normalizedDefault}
      onValueChange={handleValueChange}
    />
  );
}

function AccordionItem({ className, ...props }: AccordionPrimitive.Item.Props) {
  return (
    <AccordionPrimitive.Item
      data-slot="accordion-item"
      className={cn('border-b last:border-b-0', className)}
      {...props}
    />
  );
}

function AccordionTrigger({ className, children, ...props }: AccordionPrimitive.Trigger.Props) {
  return (
    <AccordionPrimitive.Header className="flex">
      <AccordionPrimitive.Trigger
        data-slot="accordion-trigger"
        className={cn(
          'group/accordion-trigger flex flex-1 items-start justify-between gap-4 rounded-md py-4 text-left text-sm font-medium outline-ring/50 ring-ring/10 transition-all hover:underline focus-visible:outline-1 focus-visible:ring-4 disabled:pointer-events-none disabled:opacity-50 dark:outline-ring/40 dark:ring-ring/20',
          className,
        )}
        {...props}
      >
        {children}
        <CaretDownIcon className="pointer-events-none shrink-0 text-muted-foreground group-aria-expanded/accordion-trigger:hidden" weight="regular" />
        <CaretUpIcon className="pointer-events-none hidden shrink-0 text-muted-foreground group-aria-expanded/accordion-trigger:inline" weight="regular" />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
}

function AccordionContent({ className, children, ...props }: AccordionPrimitive.Panel.Props) {
  return (
    <AccordionPrimitive.Panel
      data-slot="accordion-content"
      className="data-open:animate-accordion-down data-closed:animate-accordion-up overflow-hidden text-sm"
      {...props}
    >
      <div
        className={cn(
          'h-(--accordion-panel-height) data-ending-style:h-0 data-starting-style:h-0 pb-4 pt-0',
          className,
        )}
      >
        {children}
      </div>
    </AccordionPrimitive.Panel>
  );
}

export { Accordion, AccordionContent, AccordionItem, AccordionTrigger };
