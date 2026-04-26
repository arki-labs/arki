'use client';

import * as React from 'react';
import { Accordion as AccordionPrimitive } from '@base-ui/react/accordion';

import { CaretDownIcon, CaretUpIcon } from '@arki/icons/phosphor';

import { cn } from './cn';

function Accordion({ ...props }: AccordionPrimitive.Root.Props) {
  return <AccordionPrimitive.Root data-slot="accordion" {...props} />;
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
          'group/accordion-trigger outline-ring/50 ring-ring/10 dark:outline-ring/40 dark:ring-ring/20 flex flex-1 items-start justify-between gap-4 rounded-md py-4 text-left text-sm font-medium transition-all hover:underline focus-visible:ring-4 focus-visible:outline-1 disabled:pointer-events-none disabled:opacity-50',
          className,
        )}
        {...props}
      >
        {children}
        <CaretDownIcon className="text-muted-foreground pointer-events-none shrink-0 group-aria-expanded/accordion-trigger:hidden" />
        <CaretUpIcon className="text-muted-foreground pointer-events-none hidden shrink-0 group-aria-expanded/accordion-trigger:inline" />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
}

function AccordionContent({ className, children, ...props }: AccordionPrimitive.Panel.Props) {
  return (
    <AccordionPrimitive.Panel
      data-slot="accordion-content"
      className="overflow-hidden text-sm data-open:animate-accordion-down data-closed:animate-accordion-up"
      {...props}
    >
      <div className={cn('h-(--accordion-panel-height) pt-0 pb-4 data-ending-style:h-0 data-starting-style:h-0', className)}>
        {children}
      </div>
    </AccordionPrimitive.Panel>
  );
}

export { Accordion, AccordionContent, AccordionItem, AccordionTrigger };
