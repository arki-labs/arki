'use client';

import type { VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { WarningCircle, CheckCircle, CircleNotch, Clock } from '@arki/icons/phosphor';
import { cn } from '@arki/ui/cn';
import { cva } from 'class-variance-authority';

import type { ToolCallStatus } from './types';

const toolCallVariants = cva('rounded-lg border p-3 transition-colors animate-chat-fade-in', {
  variants: {
    status: {
      pending: 'border-border/50 bg-muted/30',
      running: 'border-primary/30 bg-primary/5 animate-chat-pulse-border',
      complete: 'border-border bg-card',
      error: 'border-destructive/30 bg-destructive/5',
    },
  },
  defaultVariants: {
    status: 'pending',
  },
});

type ToolCallProps = React.ComponentProps<'div'> &
  VariantProps<typeof toolCallVariants> & {
    toolName: string;
  };

function ToolCall({ className, status, toolName, children, ...props }: ToolCallProps) {
  return (
    <div data-slot="chat-tool-call" className={cn(toolCallVariants({ status }), className)} {...props}>
      <ToolCallHeader toolName={toolName} status={status ?? 'pending'} />
      {children}
    </div>
  );
}

function ToolCallHeader({ toolName, status }: { toolName: string; status: ToolCallStatus }) {
  return (
    <div data-slot="chat-tool-call-header" className="flex items-center gap-2">
      <ToolCallStatusIcon status={status} />
      <span className="text-sm font-medium">{toolName}</span>
      {status === 'running' && (
        <span className="text-muted-foreground animate-chat-thinking-pulse text-xs">Running...</span>
      )}
    </div>
  );
}

function ToolCallStatusIcon({ status }: { status: ToolCallStatus }) {
  switch (status) {
    case 'pending': {
      return <Clock className="text-muted-foreground size-4" />;
    }
    case 'running': {
      return <CircleNotch className="text-primary size-4 animate-spin" />;
    }
    case 'complete': {
      return <CheckCircle className="text-green-500 size-4" />;
    }
    case 'error': {
      return <WarningCircle className="text-destructive size-4" />;
    }
  }
}

function ToolCallContent({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="chat-tool-call-content" className={cn('mt-2', className)} {...props} />;
}

function ToolCallResult({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="chat-tool-call-result"
      className={cn('bg-muted/50 mt-2 rounded-md p-2 text-sm', className)}
      {...props}
    />
  );
}

export { ToolCall, ToolCallHeader, ToolCallStatusIcon, ToolCallContent, ToolCallResult, toolCallVariants };
