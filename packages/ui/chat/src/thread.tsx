'use client';

import * as React from 'react';
import { ThreadPrimitive } from '@assistant-ui/react';
import { ArrowDown } from '@arki/icons';
import { cn } from '@arki/ui/cn';

function ThreadRoot({ className, ...props }: React.ComponentProps<typeof ThreadPrimitive.Root>) {
  return (
    <ThreadPrimitive.Root
      data-slot="chat-thread"
      className={cn('flex h-full flex-col', className)}
      {...props}
    />
  );
}

function ThreadViewport({
  className,
  autoScroll = true,
  ...props
}: React.ComponentProps<typeof ThreadPrimitive.Viewport>) {
  return (
    <ThreadPrimitive.Viewport
      data-slot="chat-thread-viewport"
      autoScroll={autoScroll}
      className={cn('flex flex-1 flex-col items-center overflow-y-auto scroll-smooth', className)}
      {...props}
    />
  );
}

function ThreadMessages(props: React.ComponentProps<typeof ThreadPrimitive.Messages>) {
  return <ThreadPrimitive.Messages data-slot="chat-thread-messages" {...props} />;
}

function ThreadEmpty({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <ThreadPrimitive.Empty>
      <div
        data-slot="chat-thread-empty"
        className={cn('flex flex-1 flex-col items-center justify-center gap-4 px-4 text-center', className)}
        {...props}
      />
    </ThreadPrimitive.Empty>
  );
}

function ThreadScrollToBottom({ className, ...props }: React.ComponentProps<typeof ThreadPrimitive.ScrollToBottom>) {
  return (
    <ThreadPrimitive.ScrollToBottom
      data-slot="chat-thread-scroll-to-bottom"
      className={cn(
        'bg-background hover:bg-accent border-border/50 absolute -top-8 right-4 inline-flex size-8 items-center justify-center rounded-full border shadow-sm transition-colors',
        className,
      )}
      {...props}
    >
      <ArrowDown className="size-4" />
      <span className="sr-only">Scroll to bottom</span>
    </ThreadPrimitive.ScrollToBottom>
  );
}

export { ThreadRoot, ThreadViewport, ThreadMessages, ThreadEmpty, ThreadScrollToBottom };
