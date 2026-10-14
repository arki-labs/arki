import React, { useMemo, type ReactNode, type ComponentType } from 'react';
import KaTeX from 'katex';

type ErrorRenderer = (error: Error) => ReactNode;

export type MathComponentProps = {
  /** LaTeX expression as a string. Either `math` or `children` must be provided. */
  math?: string;
  /** LaTeX expression as React children. Either `math` or `children` must be provided. */
  children?: ReactNode;
  /** Color used by KaTeX when rendering a parse error inline (instead of throwing). */
  errorColor?: string;
  /** Custom render function for parse errors. When provided, KaTeX will throw and this handles the result. */
  renderError?: ErrorRenderer;
};

type InternalRenderProps = { html: string };

const createMathComponent = (
  Component: ComponentType<InternalRenderProps>,
  { displayMode }: { displayMode: boolean },
): ComponentType<MathComponentProps> => {
  const MathComponent = ({ children, errorColor, math, renderError }: MathComponentProps) => {
    const formula = (math ?? children ?? '') as string;

    const { html, error } = useMemo<{ html?: string; error?: Error }>(() => {
      try {
        const rendered = KaTeX.renderToString(formula, {
          displayMode,
          errorColor,
          throwOnError: !!renderError,
        });
        return { html: rendered, error: undefined };
      } catch (caught) {
        if (caught instanceof KaTeX.ParseError || caught instanceof TypeError) {
          return { error: caught };
        }
        throw caught;
      }
    }, [formula, errorColor, renderError]);

    if (error) {
      return renderError ? <>{renderError(error)}</> : <Component html={error.message} />;
    }

    return <Component html={html ?? ''} />;
  };

  return MathComponent;
};

// KaTeX produces trusted server-rendered HTML for LaTeX; embedding via
// dangerouslySetInnerHTML is the supported pattern (no untrusted user input
// flows here without going through KaTeX's own escape rules).
const InternalBlockMath = ({ html }: InternalRenderProps) => {
  return <div data-testid="react-katex" dangerouslySetInnerHTML={{ __html: html }} />;
};

const InternalInlineMath = ({ html }: InternalRenderProps) => {
  return <span data-testid="react-katex" dangerouslySetInnerHTML={{ __html: html }} />;
};

export const BlockMath: ComponentType<MathComponentProps> = createMathComponent(
  InternalBlockMath,
  { displayMode: true },
);

export const InlineMath: ComponentType<MathComponentProps> = createMathComponent(
  InternalInlineMath,
  { displayMode: false },
);
