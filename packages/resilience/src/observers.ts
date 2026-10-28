import { UnexpectedDefect } from '@arki/failure';
import { getLogger } from '@arki/log';

import type { PolicyEvent } from './policy.js';

// A reporter can synchronously re-enter an event. Do not recursively report its own defect.
let reporting = false;

function reportObserverDefect(): void {
  if (reporting) return;
  reporting = true;
  const release = () => { reporting = false; };
  try {
    const result = getLogger('arki:resilience').error('Policy observer failed ({code})', {
      code: UnexpectedDefect.code,
    });
    // Reserve reporting until settlement: an async reporter may invoke another observer.
    // Pending reporting coalesces diagnostics, never execution or its result.
    void Promise.resolve(result).then(release, release);
  } catch {
    release();
  }
}

/** Observe asynchronous returns even though event listeners have a void signature. @internal */
export function superviseObserver<E>(listener: (event: E) => void): (event: E) => void {
  return event => {
    // Keep diagnostic provenance across promise settlement, after the reporting stack unwinds.
    const canReport = !reporting;
    const report = () => {
      if (canReport) reportObserverDefect();
    };
    try {
      const result = listener(event);
      void Promise.resolve(result).catch(report);
    } catch {
      report();
    }
  };
}

/** Guard each listener before the engine can mistake its defect for an operation failure. @internal */
export function observeEvent<E>(event: PolicyEvent<E>, receiver: object): PolicyEvent<E> {
  return listener => event.call(receiver, superviseObserver(listener));
}
