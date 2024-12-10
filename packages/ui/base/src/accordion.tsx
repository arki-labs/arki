'use client';

import * as AccordionPrimitive from '@radix-ui/react-accordion';
import { LuChevronDown as ChevronDown } from 'react-icons/lu';

import { cn } from './cn';
import type { ComponentProps } from 'react';

const Accordion = AccordionPrimitive.Root;

function AccordionItem ({ className, ...props }: ComponentProps<typeof AccordionPrimitive.Item>) {
  return   <AccordionPrimitive.Item className={cn('border-b', className)} {...props} />
}
AccordionItem.displayName = 'AccordionItem';

function AccordionTrigger  ({ className, children, ...props }: ComponentProps<typeof AccordionPrimitive.Trigger>)  { return (
  <AccordionPrimitive.Header className="flex">
    <AccordionPrimitive.Trigger
      className={cn(
        'flex flex-1 items-center justify-between py-4 font-medium transition-all hover:underline [&[data-state=open]>svg]:rotate-180',
        className,
      )}
      {...props}
    >
      {children}
      <ChevronDown className="h-4 w-4 transition-transform duration-200" />
    </AccordionPrimitive.Trigger>
  </AccordionPrimitive.Header>
)}
AccordionTrigger.displayName = AccordionPrimitive.Trigger.displayName;

function AccordionContent ({ className, children, ...props }: ComponentProps<typeof AccordionPrimitive.Content>) { return (
  <AccordionPrimitive.Content
    className={cn(
      'overflow-hidden text-sm transition-all data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down',
      className,
    )}
    {...props}
  >
    <div className="pb-4 pt-0">{children}</div>
  </AccordionPrimitive.Content>
)}
AccordionContent.displayName = AccordionPrimitive.Content.displayName;

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent };
