'use client';

import * as React from 'react';
import { Check, Circle, Loader2 } from '@arki/icons';
import { cn } from '@arki/ui/cn';

import type { AgentStep } from './types';

type StepIndicatorProps = React.ComponentProps<'div'> & {
  steps: AgentStep[];
};

/**
 * Multi-step agent flow progress indicator.
 *
 * Displays a vertical step list showing which steps are pending,
 * active, complete, or errored. Useful for multi-tool agent
 * workflows where the user needs to see overall progress.
 */
function StepIndicator({ className, steps, ...props }: StepIndicatorProps) {
  return (
    <div data-slot="chat-step-indicator" className={cn('space-y-0', className)} {...props}>
      {steps.map((step, index) => (
        <Step key={step.id} step={step} isLast={index === steps.length - 1} />
      ))}
    </div>
  );
}

function Step({ step, isLast }: { step: AgentStep; isLast: boolean }) {
  return (
    <div data-slot="chat-step" className="flex gap-3">
      <div className="flex flex-col items-center">
        <StepIcon status={step.status} />
        {!isLast && (
          <div
            className={cn('w-px flex-1', step.status === 'complete' ? 'bg-primary' : 'bg-border')}
          />
        )}
      </div>
      <div className={cn('pb-4', isLast && 'pb-0')}>
        <p
          className={cn(
            'text-sm font-medium',
            step.status === 'pending' && 'text-muted-foreground',
            step.status === 'active' && 'text-foreground',
            step.status === 'complete' && 'text-foreground',
            step.status === 'error' && 'text-destructive',
          )}
        >
          {step.label}
        </p>
        {step.description && (
          <p className="text-muted-foreground mt-0.5 text-xs">{step.description}</p>
        )}
      </div>
    </div>
  );
}

function StepIcon({ status }: { status: AgentStep['status'] }) {
  const base = 'flex size-5 shrink-0 items-center justify-center rounded-full';
  switch (status) {
    case 'pending': {
      return (
        <div className={cn(base, 'border-border border')}>
          <Circle className="text-muted-foreground size-2" />
        </div>
      );
    }
    case 'active': {
      return (
        <div className={cn(base, 'bg-primary/10 border-primary border')}>
          <Loader2 className="text-primary size-3 animate-spin" />
        </div>
      );
    }
    case 'complete': {
      return (
        <div className={cn(base, 'bg-primary border-primary border')}>
          <Check className="text-primary-foreground size-3" />
        </div>
      );
    }
    case 'error': {
      return (
        <div className={cn(base, 'bg-destructive border-destructive border')}>
          <span className="text-destructive-foreground text-xs font-bold">!</span>
        </div>
      );
    }
  }
}

export { StepIndicator, Step };
