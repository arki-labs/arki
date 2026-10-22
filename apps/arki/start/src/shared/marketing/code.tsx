import { Fragment } from 'react';

import { cn } from '@arki/ui/cn';

import type { Excerpt } from './excerpt';
import type { Token } from './highlight';
import { excerptCaption, gapBefore } from './excerpt';
import { glossaryEntry } from './glossary';
import { GlossaryTerm } from './glossary-term';
import { tokenizeLines } from './highlight';

/** One line of tokens. Words in the glossary are buttons that explain themselves; the rest are plain spans. */
export function Tokens({ tokens }: Readonly<{ tokens: readonly Token[] }>) {
  return tokens.map((token, index) => {
    const className = cn(`tk-${token.kind}`, token.depth !== undefined && `tk-b${token.depth % 4}`);
    const entry = glossaryEntry(token.text, token.kind);
    return entry === undefined ? (
      <span key={index} className={className}>
        {token.text}
      </span>
    ) : (
      <GlossaryTerm key={index} word={token.text} entry={entry} className={className}>
        {token.text}
      </GlossaryTerm>
    );
  });
}

/** One line of code, coloured. */
export function HighlightedText({ text }: Readonly<{ text: string }>) {
  const [tokens = []] = tokenizeLines([text]);
  return <Tokens tokens={tokens} />;
}

/** How a stepper lights a line: the line it is on, or the line that refused. */
export type Lit = 'on' | 'bad';

type CodeProps = {
  excerpt: Excerpt;
  /** Parts to light, by part id. */
  lit?: Readonly<Record<string, Lit>>;
  /** Replaces the caption that names the files and lines. */
  caption?: string;
};

/** An excerpt in a box: the file and lines it was copied from, then the lines. */
export function Code({ excerpt, lit, caption }: Readonly<CodeProps>) {
  return (
    <figure className="home-code">
      <figcaption>{caption ?? excerptCaption(excerpt)}</figcaption>
      <pre>
        <code>
          {excerpt.parts.map((part, index) => {
            const light = lit?.[part.id];
            return (
              <Fragment key={part.id}>
                {gapBefore(excerpt.parts[index - 1], part) ? (
                  <span className="home-ln" aria-hidden="true">
                    {' '}
                  </span>
                ) : null}
                {tokenizeLines(part.lines).map((tokens, row) => (
                  <span key={row} className={cn('home-ln', light !== undefined && `is-${light}`)}>
                    <Tokens tokens={tokens} />
                  </span>
                ))}
              </Fragment>
            );
          })}
        </code>
      </pre>
    </figure>
  );
}
