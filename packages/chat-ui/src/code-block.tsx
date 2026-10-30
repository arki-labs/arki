'use client';

import * as React from 'react';
import { Check, Copy, Warning } from '@arki/icons/phosphor';
import { cn } from '@arki/ui/cn';

import { copyText } from '@arki/ui/copy-text';

type CodeBlockProps = React.ComponentProps<'div'> & {
  code: string;
  language?: string;
};

/**
 * Code block with language label and copy-to-clipboard button.
 *
 * Renders code within a styled container using a monospace font.
 * The copy button shows a check icon for 2 seconds after a copy, or
 * "Copy failed" for 2 seconds when the browser refuses the clipboard write.
 *
 * @example
 * ```tsx
 * <CodeBlock language="ts" code="const a = 1;" />
 * ```
 */
function CodeBlock({ className, code, language, ...props }: CodeBlockProps) {
  const [copyState, setCopyState] = React.useState<'idle' | 'copied' | 'failed'>('idle');

  React.useEffect(() => {
    if (copyState === 'idle') return;
    const timer = setTimeout(() => setCopyState('idle'), 2000);
    return () => clearTimeout(timer);
  }, [copyState]);

  async function handleCopy() {
    setCopyState(await copyText(code));
  }

  return (
    <div
      data-slot="chat-code-block"
      className={cn('bg-muted/50 border-border/50 overflow-hidden rounded-lg border', className)}
      {...props}
    >
      <div className="border-border/50 flex items-center justify-between border-b px-3 py-1.5">
        {language && (
          <span data-slot="chat-code-block-language" className="text-muted-foreground text-xs font-medium">
            {language}
          </span>
        )}
        <button
          type="button"
          onClick={() => void handleCopy()}
          aria-live="polite"
          className="text-muted-foreground hover:text-foreground ml-auto inline-flex items-center gap-1 text-xs transition-colors"
        >
          {copyState === 'copied' ? (
            <>
              <Check className="size-3" />
              Copied
            </>
          ) : copyState === 'failed' ? (
            <>
              <Warning className="size-3" />
              Copy failed
            </>
          ) : (
            <>
              <Copy className="size-3" />
              Copy
            </>
          )}
        </button>
      </div>
      <pre className="overflow-x-auto p-3">
        <code data-slot="chat-code-block-code" className="text-sm leading-relaxed">
          {code}
        </code>
      </pre>
    </div>
  );
}

export { CodeBlock };
