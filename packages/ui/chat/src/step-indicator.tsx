'use client';

import * as React from 'react';
import { Check, Circle, CircleNotch } from '@arki/icons/phosphor';
import { cn } from '@arki/ui/cn';

import type { AgentStep } from './types';

type StepIndicatorProps = React.ComponentProps<'div'> & {
  steps: AgentStep[];
  /**
   * Layout direction. `vertical` (default) is a stacked list for multi-tool flows; `horizontal`
   * is a compact rail (icon over label, flanked connectors) for a stage rail like B-R-A-N-D.
   */
  orientation?: 'vertical' | 'horizontal';
};

/**
 * Multi-step agent flow progress indicator.
 *
 * Shows which steps are pending, active, complete, or errored. `vertical` suits a multi-tool
 * agent workflow where the user reads top-to-bottom; `horizontal` suits a compact stage rail.
 */
function StepIndicator({ className, steps, orientation = 'vertical', ...props }: StepIndicatorProps) {
  if (orientation === 'horizontal') {
    return (
      <div
        data-slot="chat-step-indicator"
        data-orientation="horizontal"
        className={cn('flex items-start', className)}
        {...props}
      >
        {steps.map((step, index) => (
          <HorizontalStep
            key={step.id}
            step={step}
            isFirst={index === 0}
            isLast={index === steps.length - 1}
          />
        ))}
      </div>
    );
  }

  return (
    <div data-slot="chat-step-indicator" data-orientation="vertical" className={cn('space-y-0', className)} {...props}>
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

function HorizontalStep({ step, isFirst, isLast }: { step: AgentStep; isFirst: boolean; isLast: boolean }) {
  const connector = (visible: boolean) => (
    <span className={cn('h-px flex-1', visible && step.status === 'complete' ? 'bg-primary' : 'bg-border', !visible && 'invisible')} />
  );
  return (
    <div data-slot="chat-step" data-orientation="horizontal" className="flex flex-1 flex-col items-center" title={step.description}>
      <div className="flex w-full items-center">
        {connector(!isFirst)}
        <StepIcon status={step.status} />
        {connector(!isLast)}
      </div>
      <p
        className={cn(
          'mt-1 text-center text-[11px] font-medium leading-tight',
          step.status === 'pending' && 'text-muted-foreground',
          step.status === 'active' && 'text-foreground',
          step.status === 'complete' && 'text-foreground',
          step.status === 'error' && 'text-destructive',
        )}
      >
        {step.label}
      </p>
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
          <CircleNotch className="text-primary size-3 animate-spin" />
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
