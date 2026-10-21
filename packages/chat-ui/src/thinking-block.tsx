'use client';

import * as React from 'react';
import type { ReasoningMessagePartProps } from '@assistant-ui/react';
import { ChainOfThoughtPrimitive } from '@assistant-ui/react';
import { Brain, CaretDown } from '@arki/icons/phosphor';
import { cn } from '@arki/ui/cn';

type ThinkingBlockProps = React.ComponentProps<typeof ChainOfThoughtPrimitive.Root> & {
  label?: string;
  duration?: number;
};

/**
 * Collapsible reasoning/chain-of-thought block that wraps
 * assistant-ui's ChainOfThoughtPrimitive.
 *
 * Shows a "Thinking..." indicator during streaming, then collapses
 * to a summary with a chevron to expand the full reasoning.
 *
 * @example
 * ```tsx
 * <ThinkingBlock label="Thinking" duration={1200} />
 * ```
 */
function ThinkingBlock({ className, label, duration, ...props }: ThinkingBlockProps) {
  return (
    <ChainOfThoughtPrimitive.Root
      data-slot="chat-thinking-block"
      className={cn('border-border/50 my-2 rounded-lg border', className)}
      {...props}
    >
      <ThinkingBlockTrigger label={label} duration={duration} />
      <ChainOfThoughtPrimitive.Parts
        components={{
          Reasoning: ThinkingBlockReasoning,
        }}
      />
    </ChainOfThoughtPrimitive.Root>
  );
}

function ThinkingBlockTrigger({ label = 'Thinking', duration }: { label?: string; duration?: number }) {
  return (
    <ChainOfThoughtPrimitive.AccordionTrigger
      data-slot="chat-thinking-block-trigger"
      className="hover:bg-muted/50 group flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors"
    >
      <Brain className="text-muted-foreground size-4" />
      <span className="text-muted-foreground font-medium">{label}</span>
      {duration != null && (
        <span className="text-muted-foreground/60 text-xs">{formatDuration(duration)}</span>
      )}
      <CaretDown className="text-muted-foreground ml-auto size-3.5 transition-transform group-data-[state=open]:rotate-180" />
    </ChainOfThoughtPrimitive.AccordionTrigger>
  );
}

function ThinkingBlockReasoning({ text }: ReasoningMessagePartProps) {
  return (
    <div
      data-slot="chat-thinking-block-reasoning"
      className="text-muted-foreground border-border/50 border-t px-3 py-2 text-sm leading-relaxed"
    >
      {text}
    </div>
  );
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

export { ThinkingBlock, ThinkingBlockTrigger, ThinkingBlockReasoning };
