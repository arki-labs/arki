import { Fragment, useEffect, useRef } from 'react';

import { cn } from '@arki/ui/cn';

import type { Excerpt } from './build-steps';
import type { Token } from './highlight';
import type { Lit } from './journal-model';
import { excerptCaption } from './build-steps';
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

type CodeProps = {
  excerpt: Excerpt;
  /** Parts to light, by part id. */
  lit?: Readonly<Record<string, Lit>>;
  /** Replaces the caption that names the files and lines. */
  caption?: string;
};

/** An excerpt in a box: the file and lines it was copied from, then the lines. */
export function Code({ excerpt, lit, caption }: Readonly<CodeProps>) {
  const figure = useRef<HTMLElement>(null);
  const mounted = useRef(false);
  const litKey = lit === undefined ? '' : Object.keys(lit).join(',');
  // When a stepper lights another line, keep that line in view: on a phone the code sits above the controls.
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    const line = figure.current?.querySelector('.home-ln.is-on, .home-ln.is-bad');
    if (!(line instanceof HTMLElement)) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    line.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
  }, [litKey]);

  return (
    <figure className="home-code" ref={figure}>
      <figcaption>{caption ?? excerptCaption(excerpt)}</figcaption>
      <pre>
        <code>
          {excerpt.parts.map((part, index) => {
            const before = excerpt.parts[index - 1];
            const joined =
              before !== undefined && before.path === part.path && before.from + before.lines.length === part.from;
            const light = lit?.[part.id];
            return (
              <Fragment key={part.id}>
                {index > 0 && !joined ? (
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
