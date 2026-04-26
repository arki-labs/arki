'use client';

import * as React from 'react';
import { Warning, Check, Pencil, X } from '@arki/icons/phosphor';
import { cn } from '@arki/ui/cn';

import type { ApprovalAction, ApprovalResult } from './types';

type ApprovalCardProps = React.ComponentProps<'div'> & {
  title: string;
  description?: string;
  onAction: (result: ApprovalResult) => void;
};

/**
 * Human-in-the-loop approval card for high-risk agent actions.
 *
 * Renders an inline confirmation UI with Approve / Edit / Reject actions.
 * On reject, shows a feedback input for the user to explain why,
 * which is fed back to the agent as context.
 */
function ApprovalCard({ className, title, description, onAction, children, ...props }: ApprovalCardProps) {
  const [feedback, setFeedback] = React.useState('');
  const [showFeedback, setShowFeedback] = React.useState(false);

  function handleAction(action: ApprovalAction) {
    if (action === 'reject' && !showFeedback) {
      setShowFeedback(true);
      return;
    }
    onAction({ action, feedback: action === 'reject' ? feedback : undefined });
  }

  return (
    <div
      data-slot="chat-approval-card"
      className={cn(
        'border-warning/30 bg-warning/5 animate-chat-slide-up rounded-lg border p-4',
        className,
      )}
      {...props}
    >
      <div className="flex items-start gap-3">
        <Warning className="text-warning mt-0.5 size-5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{title}</p>
          {description && <p className="text-muted-foreground mt-1 text-sm">{description}</p>}
          {children}

          {showFeedback && (
            <textarea
              data-slot="chat-approval-feedback"
              className="border-border bg-background mt-3 w-full rounded-md border p-2 text-sm outline-none focus:ring-1 focus:ring-ring"
              placeholder="Why are you rejecting? (optional feedback for the agent)"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              rows={2}
            />
          )}

          <ApprovalActions onAction={handleAction} showFeedback={showFeedback} />
        </div>
      </div>
    </div>
  );
}

function ApprovalActions({
  onAction,
  showFeedback,
}: {
  onAction: (action: ApprovalAction) => void;
  showFeedback: boolean;
}) {
  return (
    <div data-slot="chat-approval-actions" className="mt-3 flex items-center gap-2">
      <button
        type="button"
        onClick={() => onAction('approve')}
        className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors"
      >
        <Check className="size-3.5" />
        Approve
      </button>
      <button
        type="button"
        onClick={() => onAction('edit')}
        className="bg-secondary text-secondary-foreground hover:bg-secondary/80 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors"
      >
        <Pencil className="size-3.5" />
        Edit
      </button>
      <button
        type="button"
        onClick={() => onAction('reject')}
        className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors"
      >
        <X className="size-3.5" />
        {showFeedback ? 'Submit Rejection' : 'Reject'}
      </button>
    </div>
  );
}

export { ApprovalCard, ApprovalActions };
