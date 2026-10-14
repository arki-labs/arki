'use client';

import * as React from 'react';
import { cn } from '@arki/ui/cn';

type MarkdownMessageProps = React.ComponentProps<'div'> & {
  children: React.ReactNode;
};

/**
 * Styled container for markdown-rendered AI messages.
 *
 * Applies prose-like typography styles to rendered markdown content.
 * This component styles the container — the actual markdown rendering
 * should be handled by the consuming app using `react-markdown`,
 * `streamdown`, or assistant-ui's built-in markdown support.
 *
 * @example
 * ```tsx
 * import { MarkdownMessage } from '@arki/chat-ui/markdown-message';
 * import ReactMarkdown from 'react-markdown';
 *
 * <MarkdownMessage>
 *   <ReactMarkdown>{content}</ReactMarkdown>
 * </MarkdownMessage>
 * ```
 */
function MarkdownMessage({ className, ...props }: MarkdownMessageProps) {
  return (
    <div
      data-slot="chat-markdown-message"
      className={cn(
        // Prose-like typography for AI-generated markdown
        'text-sm leading-relaxed',
        // Headings
        '[&_h1]:mb-3 [&_h1]:mt-6 [&_h1]:text-lg [&_h1]:font-semibold',
        '[&_h2]:mb-2 [&_h2]:mt-5 [&_h2]:text-base [&_h2]:font-semibold',
        '[&_h3]:mb-2 [&_h3]:mt-4 [&_h3]:text-sm [&_h3]:font-semibold',
        // Paragraphs
        '[&_p]:mb-3 [&_p]:last:mb-0',
        // Lists
        '[&_ul]:mb-3 [&_ul]:list-disc [&_ul]:pl-6',
        '[&_ol]:mb-3 [&_ol]:list-decimal [&_ol]:pl-6',
        '[&_li]:mb-1',
        // Inline code
        '[&_code:not(pre_code)]:bg-muted [&_code:not(pre_code)]:rounded [&_code:not(pre_code)]:px-1.5 [&_code:not(pre_code)]:py-0.5 [&_code:not(pre_code)]:text-xs [&_code:not(pre_code)]:font-mono',
        // Code blocks
        '[&_pre]:bg-muted/50 [&_pre]:mb-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:p-3',
        '[&_pre_code]:text-xs [&_pre_code]:leading-relaxed',
        // Links
        '[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2',
        // Blockquotes
        '[&_blockquote]:border-border [&_blockquote]:text-muted-foreground [&_blockquote]:mb-3 [&_blockquote]:border-l-2 [&_blockquote]:pl-4 [&_blockquote]:italic',
        // Tables
        '[&_table]:mb-3 [&_table]:w-full [&_table]:text-left',
        '[&_th]:border-border [&_th]:border-b [&_th]:px-3 [&_th]:py-1.5 [&_th]:text-xs [&_th]:font-semibold',
        '[&_td]:border-border [&_td]:border-b [&_td]:px-3 [&_td]:py-1.5 [&_td]:text-xs',
        // Horizontal rule
        '[&_hr]:border-border [&_hr]:my-4',
        // Strong/em
        '[&_strong]:font-semibold',
        className,
      )}
      {...props}
    />
  );
}

export { MarkdownMessage };
