'use client';

import * as React from 'react';
import { BranchPickerPrimitive } from '@assistant-ui/react';
import { ChevronLeft, ChevronRight } from '@arki/icons';
import { cn } from '@arki/ui/cn';

function BranchPicker({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <BranchPickerPrimitive.Root
      data-slot="chat-branch-picker"
      className={cn(
        'text-muted-foreground inline-flex items-center gap-1 text-xs',
        className,
      )}
      hideWhenSingleBranch
      {...props}
    >
      <BranchPickerPrevious />
      <span className="tabular-nums">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerNext />
    </BranchPickerPrimitive.Root>
  );
}

const navButtonStyles =
  'hover:text-foreground hover:bg-accent inline-flex size-5 items-center justify-center rounded transition-colors disabled:opacity-40';

function BranchPickerPrevious({
  className,
  ...props
}: React.ComponentProps<typeof BranchPickerPrimitive.Previous>) {
  return (
    <BranchPickerPrimitive.Previous
      data-slot="chat-branch-picker-previous"
      className={cn(navButtonStyles, className)}
      {...props}
    >
      <ChevronLeft className="size-3" />
      <span className="sr-only">Previous version</span>
    </BranchPickerPrimitive.Previous>
  );
}

function BranchPickerNext({
  className,
  ...props
}: React.ComponentProps<typeof BranchPickerPrimitive.Next>) {
  return (
    <BranchPickerPrimitive.Next
      data-slot="chat-branch-picker-next"
      className={cn(navButtonStyles, className)}
      {...props}
    >
      <ChevronRight className="size-3" />
      <span className="sr-only">Next version</span>
    </BranchPickerPrimitive.Next>
  );
}

export { BranchPicker, BranchPickerPrevious, BranchPickerNext };
