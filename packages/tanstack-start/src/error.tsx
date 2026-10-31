/**
 * Rich `defaultErrorComponent` for TanStack Router.
 *
 * Drop into `createRouter({ defaultErrorComponent: RootErrorComponent })`.
 *
 * Production: minimal recoverable card (icon + title + reason + actions).
 *
 * Development: also dumps the full error name, message, stack, cause chain,
 * and React component stack so the cause is visible without opening devtools.
 * The dev branch is tree-shaken in production via `import.meta.env.DEV`.
 */
import { useEffect } from 'react';
import type { ErrorComponentProps } from '@tanstack/react-router';

import { ArrowClockwiseIcon, BugIcon, HouseSimpleIcon, WarningIcon } from '@arki/icons/phosphor';
import { Button } from '@arki/ui/button';
import { cn } from '@arki/ui/utils';

import { captureException } from './sentry-bridge.js';

type RootErrorComponentProps = ErrorComponentProps<unknown> & {
  /**
   * Optional className applied to the outer wrapper. Use this when an app
   * wants to override the default centered layout (e.g. embed inside a
   * narrower shell).
   */
  className?: string;
};

export function RootErrorComponent({ error, info, reset, className }: RootErrorComponentProps) {
  const normalized = normalizeError(error);
  const isDev = import.meta.env.DEV;

  // Forward to Sentry via the local bridge. No-op when the host app
  // hasn't called `initSentryClient` — which avoids pulling `@sentry/*`
  // into bundles for apps that never opt in.
  useEffect(() => {
    captureException(error, {
      contexts: {
        react: info?.componentStack ? { componentStack: info.componentStack } : {},
        source: { from: '@arki/tanstack-start/error#RootErrorComponent' },
      },
    });
  }, [error, info?.componentStack]);

  return (
    <div
      role="alert"
      className={cn(
        'flex min-h-dvh flex-col items-center justify-center gap-6 bg-background p-6',
        className,
      )}
    >
      <div className="w-full max-w-2xl rounded-md border border-destructive/30 bg-destructive/5 p-8 text-center">
        <WarningIcon className="mx-auto mb-3 size-8 text-destructive" aria-hidden="true" />
        <h1 className="text-lg font-semibold">Something went wrong</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {normalized.message || 'An unexpected error interrupted the page render.'}
        </p>
        <div className="mt-5 flex flex-col items-center gap-2 sm:flex-row sm:justify-center">
          <Button onClick={reset}>
            <ArrowClockwiseIcon className="size-4" aria-hidden="true" />
            Try again
          </Button>
          <Button variant="outline" asChild>
            <a href="/">
              <HouseSimpleIcon className="size-4" aria-hidden="true" />
              Back to home
            </a>
          </Button>
        </div>
      </div>

      {isDev ? (
        <DevDiagnostics error={normalized} componentStack={info?.componentStack} />
      ) : null}
    </div>
  );
}

type NormalizedError = {
  name: string;
  message: string;
  stack?: string;
  causes: { name: string; message: string; stack?: string }[];
};

function normalizeError(error: unknown): NormalizedError {
  if (error instanceof Error) {
    // Cause chains are arbitrary user data: they can be cyclic (e.cause === e)
    // or unboundedly deep, and this runs during SSR — walk them guarded.
    const causes: NormalizedError['causes'] = [];
    const seen = new Set<Error>([error]);
    let current = (error as Error & { cause?: unknown }).cause;
    while (current instanceof Error && !seen.has(current) && causes.length < 10) {
      seen.add(current);
      causes.push({ name: current.name, message: current.message, stack: current.stack });
      current = (current as Error & { cause?: unknown }).cause;
    }
    return { name: error.name, message: error.message, stack: error.stack, causes };
  }
  if (typeof error === 'string') {
    return { name: 'Error', message: error, causes: [] };
  }
  return { name: 'UnknownError', message: safeStringify(error), causes: [] };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}


function DevDiagnostics({
  error,
  componentStack,
}: {
  error: NormalizedError;
  componentStack?: string;
}) {
  return (
    <details
      open
      className="w-full max-w-4xl rounded-md border border-border bg-card text-left text-card-foreground shadow-sm"
    >
      <summary className="flex cursor-pointer items-center gap-2 rounded-t-md border-b border-border bg-muted/40 px-4 py-2 text-sm font-medium">
        <BugIcon className="size-4 text-muted-foreground" aria-hidden="true" />
        Dev diagnostics
        <span className="ml-auto text-xs font-normal text-muted-foreground">
          dev-only — never shipped to production
        </span>
      </summary>
      <div className="space-y-4 p-4 font-mono text-xs">
        <DiagnosticBlock label={error.name} body={error.message} stack={error.stack} />
        {error.causes.map((cause, index) => (
          <DiagnosticBlock
            key={`${cause.name}-${index}`}
            label={`caused by · ${cause.name}`}
            body={cause.message}
            stack={cause.stack}
          />
        ))}
        {componentStack ? (
          <DiagnosticBlock label="React component stack" body="" stack={componentStack} />
        ) : null}
      </div>
    </details>
  );
}

function DiagnosticBlock({
  label,
  body,
  stack,
}: {
  label: string;
  body: string;
  stack?: string;
}) {
  return (
    <div className="space-y-2">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      {body ? <div className="whitespace-pre-wrap text-foreground">{body}</div> : null}
      {stack ? (
        <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-muted/40 p-3 text-[11px] leading-relaxed text-muted-foreground">
          {stack}
        </pre>
      ) : null}
    </div>
  );
}
