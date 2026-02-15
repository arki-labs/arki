'use client';

import * as React from 'react';
import { ComposerPrimitive } from '@assistant-ui/react';
import { SendHorizontal } from '@arki/icons';
import { cn } from '@arki/ui/cn';

function Composer({ className, ...props }: React.ComponentProps<typeof ComposerPrimitive.Root>) {
  return (
    <ComposerPrimitive.Root
      data-slot="chat-composer"
      className={cn(
        'bg-background border-border/50 focus-within:border-ring/50 relative flex w-full items-end gap-2 rounded-2xl border px-4 py-3 shadow-sm transition-colors',
        className,
      )}
      {...props}
    />
  );
}

function ComposerInput({ className, ...props }: React.ComponentProps<typeof ComposerPrimitive.Input>) {
  return (
    <ComposerPrimitive.Input
      data-slot="chat-composer-input"
      autoFocus
      className={cn(
        'placeholder:text-muted-foreground max-h-40 flex-1 resize-none bg-transparent text-sm outline-none',
        className,
      )}
      {...props}
    />
  );
}

function ComposerSend({ className, ...props }: React.ComponentProps<typeof ComposerPrimitive.Send>) {
  return (
    <ComposerPrimitive.Send
      data-slot="chat-composer-send"
      className={cn(
        'bg-primary text-primary-foreground hover:bg-primary/90 inline-flex size-8 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-40',
        className,
      )}
      {...props}
    >
      <SendHorizontal className="size-4" />
      <span className="sr-only">Send message</span>
    </ComposerPrimitive.Send>
  );
}

function ComposerCancel({ className, ...props }: React.ComponentProps<typeof ComposerPrimitive.Cancel>) {
  return (
    <ComposerPrimitive.Cancel
      data-slot="chat-composer-cancel"
      className={cn(
        'text-muted-foreground hover:text-foreground inline-flex size-8 shrink-0 items-center justify-center rounded-full transition-colors',
        className,
      )}
      {...props}
    >
      <span className="sr-only">Cancel</span>
    </ComposerPrimitive.Cancel>
  );
}

function ComposerAttachments(props: React.ComponentProps<typeof ComposerPrimitive.Attachments>) {
  return <ComposerPrimitive.Attachments data-slot="chat-composer-attachments" {...props} />;
}

export { Composer, ComposerInput, ComposerSend, ComposerCancel, ComposerAttachments };
