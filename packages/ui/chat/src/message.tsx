'use client';

import * as React from 'react';
import { MessagePrimitive } from '@assistant-ui/react';
import { cn } from '@arki/ui/cn';

function UserMessage({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <MessagePrimitive.Root>
      <div
        data-slot="chat-user-message"
        className={cn('flex w-full max-w-2xl gap-3 py-4 pl-12', className)}
        {...props}
      />
    </MessagePrimitive.Root>
  );
}

function UserMessageContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="chat-user-message-content"
      className={cn(
        'bg-primary text-primary-foreground ml-auto max-w-[85%] rounded-2xl rounded-br-sm px-4 py-2.5 text-sm',
        className,
      )}
      {...props}
    >
      <MessagePrimitive.Content />
    </div>
  );
}

function AssistantMessage({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <MessagePrimitive.Root>
      <div
        data-slot="chat-assistant-message"
        className={cn('flex w-full max-w-2xl gap-3 py-4 pr-12', className)}
        {...props}
      />
    </MessagePrimitive.Root>
  );
}

function AssistantMessageContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="chat-assistant-message-content"
      className={cn(
        'bg-muted text-foreground max-w-[85%] rounded-2xl rounded-bl-sm px-4 py-2.5 text-sm',
        className,
      )}
      {...props}
    >
      <MessagePrimitive.Content />
    </div>
  );
}

function SystemMessage({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <MessagePrimitive.Root>
      <div
        data-slot="chat-system-message"
        className={cn(
          'text-muted-foreground mx-auto w-full max-w-2xl px-4 py-2 text-center text-xs italic',
          className,
        )}
        {...props}
      />
    </MessagePrimitive.Root>
  );
}

function MessageContent(props: React.ComponentProps<typeof MessagePrimitive.Content>) {
  return <MessagePrimitive.Content data-slot="chat-message-content" {...props} />;
}

export {
  UserMessage,
  UserMessageContent,
  AssistantMessage,
  AssistantMessageContent,
  SystemMessage,
  MessageContent,
};
