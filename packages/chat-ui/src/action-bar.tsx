'use client';

import * as React from 'react';
import { ActionBarPrimitive } from '@assistant-ui/react';
import { Check, Copy, Pencil, ArrowsClockwise } from '@arki/icons/phosphor';
import { cn } from '@arki/ui/cn';

/**
 * Copy, reload and edit buttons for one message.
 *
 * @example
 * ```tsx
 * <ActionBar><ActionBarCopy /><ActionBarReload /></ActionBar>
 * ```
 */
function ActionBar({ className, ...props }: React.ComponentProps<typeof ActionBarPrimitive.Root>) {
  return (
    <ActionBarPrimitive.Root
      data-slot="chat-action-bar"
      className={cn('flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100', className)}
      {...props}
    />
  );
}

const actionButtonStyles =
  'text-muted-foreground hover:text-foreground hover:bg-accent inline-flex size-7 items-center justify-center rounded-md transition-colors';

function ActionBarCopy({ className, ...props }: React.ComponentProps<typeof ActionBarPrimitive.Copy>) {
  return (
    <ActionBarPrimitive.Copy
      data-slot="chat-action-bar-copy"
      className={cn(actionButtonStyles, 'group/copy', className)}
      copiedDuration={2000}
      {...props}
    >
      <Copy className="size-3.5 group-data-[copied]/copy:hidden" />
      <Check className="text-green-500 hidden size-3.5 group-data-[copied]/copy:block" />
      <span className="sr-only">Copy message</span>
    </ActionBarPrimitive.Copy>
  );
}

function ActionBarReload({ className, ...props }: React.ComponentProps<typeof ActionBarPrimitive.Reload>) {
  return (
    <ActionBarPrimitive.Reload
      data-slot="chat-action-bar-reload"
      className={cn(actionButtonStyles, className)}
      {...props}
    >
      <ArrowsClockwise className="size-3.5" />
      <span className="sr-only">Regenerate</span>
    </ActionBarPrimitive.Reload>
  );
}

function ActionBarEdit({ className, ...props }: React.ComponentProps<typeof ActionBarPrimitive.Edit>) {
  return (
    <ActionBarPrimitive.Edit
      data-slot="chat-action-bar-edit"
      className={cn(actionButtonStyles, className)}
      {...props}
    >
      <Pencil className="size-3.5" />
      <span className="sr-only">Edit</span>
    </ActionBarPrimitive.Edit>
  );
}

export { ActionBar, ActionBarCopy, ActionBarReload, ActionBarEdit };
