'use client';

import type { VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { WarningCircle, Brain, CheckCircle, CircleNotch, ChatTeardrop, Pause } from '@arki/icons/phosphor';
import { cn } from '@arki/ui/cn';
import { cva } from 'class-variance-authority';

import type { AgentStatusType } from './types';

const agentStatusVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors',
  {
    variants: {
      status: {
        idle: 'bg-muted text-muted-foreground',
        thinking: 'bg-primary/10 text-primary animate-chat-thinking-pulse',
        executing: 'bg-primary/10 text-primary',
        'waiting-for-input': 'bg-warning/10 text-warning',
        complete: 'bg-green-500/10 text-green-600 dark:text-green-400',
        error: 'bg-destructive/10 text-destructive',
      },
    },
    defaultVariants: {
      status: 'idle',
    },
  },
);

type AgentStatusProps = React.ComponentProps<'span'> &
  VariantProps<typeof agentStatusVariants> & {
    label?: string;
  };

function AgentStatus({ className, status, label, ...props }: AgentStatusProps) {
  const resolvedLabel = label ?? defaultLabel(status ?? 'idle');

  return (
    <span data-slot="chat-agent-status" className={cn(agentStatusVariants({ status }), className)} {...props}>
      <AgentStatusIcon status={status ?? 'idle'} />
      {resolvedLabel}
    </span>
  );
}

function AgentStatusIcon({ status }: { status: AgentStatusType }) {
  const iconClass = 'size-3';
  switch (status) {
    case 'idle': {
      return <ChatTeardrop className={iconClass} />;
    }
    case 'thinking': {
      return <Brain className={iconClass} />;
    }
    case 'executing': {
      return <CircleNotch className={cn(iconClass, 'animate-spin')} />;
    }
    case 'waiting-for-input': {
      return <Pause className={iconClass} />;
    }
    case 'complete': {
      return <CheckCircle className={iconClass} />;
    }
    case 'error': {
      return <WarningCircle className={iconClass} />;
    }
  }
}

function defaultLabel(status: AgentStatusType): string {
  switch (status) {
    case 'idle': {
      return 'Idle';
    }
    case 'thinking': {
      return 'Thinking...';
    }
    case 'executing': {
      return 'Executing...';
    }
    case 'waiting-for-input': {
      return 'Waiting for input';
    }
    case 'complete': {
      return 'Complete';
    }
    case 'error': {
      return 'Error';
    }
  }
}

export { AgentStatus, AgentStatusIcon, agentStatusVariants };
