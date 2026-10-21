import { useReducer } from 'react';

import { cn } from '@arki/ui/cn';

import { PAY_ORDER, REFUND_WORKFLOW } from './build-steps';
import { Code } from './code';
import { COMMAND_START, commandReducer, commandView, REFUND_START, refundReducer, refundView } from './journal-model';
import { useHydrated } from './use-hydrated';

const PLAY_ICON = 'M4 2l9 6-9 6z';
const CLOCK_ICON = 'M8 4v4l3 2';

type ActionButtonProps = {
  label: string;
  onClick: () => void;
  tone?: 'go' | 'quiet';
  pressed?: boolean;
  icon?: string;
};

function ActionButton({ label, onClick, tone, pressed, icon }: Readonly<ActionButtonProps>) {
  return (
    <button
      className={cn('home-act', tone === 'go' && 'is-go', tone === 'quiet' && 'is-quiet')}
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
    >
      {icon === undefined ? null : (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d={icon} />
        </svg>
      )}
      {label}
    </button>
  );
}

/** Part 1: `payOrder` runs line by line, and one transaction writes four things, or nothing. */
function OneTransaction({ interactive }: Readonly<{ interactive: boolean }>) {
  const [state, send] = useReducer(commandReducer, COMMAND_START);
  const view = commandView(state);
  return (
    <div className="home-cpart" role="group" aria-labelledby="journal-one-tx">
      <p className="home-kicker">
        <b>Part 1</b> · one transaction
      </p>
      <h3 id="journal-one-tx">Run a command. Watch one transaction write four things, or nothing.</h3>
      <p className="home-ctext">
        A command reads the row, applies a rule, and returns events. <code>write</code> appends the event, runs the
        reducer on the row, runs the inline projections and queues the after-commit jobs, all in one transaction. A rule
        that says no returns a typed failure, and nothing is written.
      </p>
      <div className="home-two">
        <Code excerpt={PAY_ORDER} lit={view.lit} />
        <div>
          {interactive ? (
            <div className="home-ctl">
              {view.canRun ? (
                <ActionButton tone="go" icon={PLAY_ICON} label={view.runLabel} onClick={() => send({ type: 'run' })} />
              ) : null}
              {view.canDecide ? (
                <>
                  <ActionButton tone="go" label="Commit" onClick={() => send({ type: 'commit' })} />
                  <ActionButton label="Roll back" onClick={() => send({ type: 'rollback' })} />
                </>
              ) : null}
              <ActionButton label="Make it fail" pressed={state.fail} onClick={() => send({ type: 'toggleFail' })} />
              <ActionButton tone="quiet" label="Reset" onClick={() => send({ type: 'reset' })} />
            </div>
          ) : null}
          <p className="home-status" aria-live="polite">
            {view.status}
          </p>
          <div className={cn('home-tx', `is-${view.box}`)} role="group" aria-label="One transaction">
            <p className="home-tx-label">{view.boxLabel}</p>
            <div className={cn('home-pane', `is-${view.panes}`)}>
              <strong>orders · row</strong>
              id: input.orderId
              <br />
              status: <span className={cn('home-val', view.rowHot && 'is-hot')}>{view.rowStatus}</span>
              <small>{"reducer .on(OrderPaid, () => ({ status: 'paid' })) · README.md:76"}</small>
            </div>
            <div className={cn('home-pane', `is-${view.panes}`)}>
              <strong>journal_events · new row</strong>
              {view.event}
              <small>appended before the row is saved</small>
            </div>
            <div className={cn('home-pane', `is-${view.panes}`)}>
              <strong>customer-stats · projection</strong>
              {view.projection}
              <small>inline lane: same transaction · README.md:93</small>
            </div>
            <div className={cn('home-pane', `is-${view.panes}`)}>
              <strong>journal_jobs · after commit</strong>
              {view.job}
              <small>{"effect 'order-mail' on OrderPaid · README.md:106–114"}</small>
            </div>
          </div>
          {view.failed ? (
            <div className="home-fail">
              <strong>returned, not thrown</strong>
              {"CommandConflict({ detail: 'Order is already paid' })"}
              <br />
              The transaction rolls back. <code>run</code> returns this value, typed.
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Part 2: one refund, step by step, with the rows it writes into `journal_events`. */
function RefundWorkflow({ interactive }: Readonly<{ interactive: boolean }>) {
  const [state, send] = useReducer(refundReducer, REFUND_START);
  const view = refundView(state);
  return (
    <div className="home-cpart" role="group" aria-labelledby="journal-refund">
      <p className="home-kicker">
        <b>Part 2</b> · a workflow is rows too
      </p>
      <h3 id="journal-refund">A refund that waits three days. Its history sits in the same table as yours.</h3>
      <p className="home-ctext">
        A durable workflow is a journal entity. It starts from a domain event, inside that event&apos;s transaction. A
        step retries with one idempotency key. It parks on a signal with a timeout. Every checkpoint is a row in{' '}
        <code>journal_events</code>, next to the domain event that started it. Click through one refund.
      </p>
      <div className="home-two">
        <Code excerpt={REFUND_WORKFLOW} lit={view.lit} />
        <div>
          {interactive ? (
            <div className="home-ctl">
              {state.stage === 'idle' ? (
                <ActionButton tone="go" label="Approve refund" onClick={() => send({ type: 'approve' })} />
              ) : null}
              {state.stage === 'approved' ? (
                <ActionButton tone="go" label="Run step payBack" onClick={() => send({ type: 'payBack' })} />
              ) : null}
              {state.stage === 'paid' ? (
                <>
                  {state.retried ? null : (
                    <ActionButton label="Retry this step" onClick={() => send({ type: 'retry' })} />
                  )}
                  <ActionButton tone="go" label="waitFor('settled')" onClick={() => send({ type: 'wait' })} />
                </>
              ) : null}
              {state.stage === 'parked' ? (
                <>
                  <ActionButton tone="go" label="Stripe webhook arrives" onClick={() => send({ type: 'signal' })} />
                  <ActionButton label="Let 3 days pass" onClick={() => send({ type: 'timeout' })} />
                </>
              ) : null}
              {state.stage === 'woken' ? (
                <ActionButton tone="go" label="Run step record" onClick={() => send({ type: 'record' })} />
              ) : null}
              <ActionButton tone="quiet" label="Reset" onClick={() => send({ type: 'reset' })} />
            </div>
          ) : null}
          <p className="home-status" aria-live="polite">
            {view.status}
          </p>
          {view.parked ? (
            <p>
              <span className="home-badge">
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <circle cx="8" cy="8" r="6" />
                  <path d={CLOCK_ICON} />
                </svg>
                parked · timeout 3d
              </span>
            </p>
          ) : null}
          {view.finished ? (
            <p>
              <span className="home-done">RunCompleted · outcome: &apos;completed&apos;</span>
            </p>
          ) : null}
          <div className="home-ledger">
            <table>
              <caption>journal_events · one table</caption>
              <thead>
                <tr>
                  <th scope="col">seq</th>
                  <th scope="col">entity</th>
                  <th scope="col">event</th>
                  <th scope="col">kind</th>
                  <th scope="col">note</th>
                </tr>
              </thead>
              <tbody aria-live="polite">
                {view.rows.length === 0 ? (
                  <tr className="is-empty">
                    <td colSpan={5}>No rows yet. Approve the refund.</td>
                  </tr>
                ) : (
                  view.rows.map(row => (
                    <tr key={row.seq} className={cn(`is-${row.kind}`, row.fresh && 'is-new')}>
                      <td className="home-seq">{row.seq}</td>
                      <td>{row.entity}</td>
                      <td>{row.detail === undefined ? row.event : `${row.event} · ${row.detail}`}</td>
                      <td className="home-kind">
                        <span>{row.kind}</span>
                      </td>
                      <td className="home-rownote">{row.note}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Part 3: what the journal does, in its own terms, and the apps that use it. */
function Standing() {
  return (
    <div className="home-cpart" role="group" aria-labelledby="journal-standing">
      <p className="home-kicker">
        <b>Part 3</b> · what it gives you
      </p>
      <h3 id="journal-standing">One transaction. One log.</h3>
      <div className="home-cmp">
        <div>
          <strong>One transaction</strong>
          The row, the event, the read models and the queued jobs are written together, or not at all. A rule that says
          no returns a typed failure and writes nothing.
        </div>
        <div className="is-us">
          <strong>One log</strong>A workflow&apos;s history sits in the same Postgres log as your domain history:
          retries, sleeps, waits for a signal and child runs are rows, safe to repeat with an idempotency key.
        </div>
      </div>
      <div className="home-cards">
        <div className="home-card">
          <strong>kapodopera</strong>
          <p>
            Refunds: <code>startOn RefundApproved</code>, <code>payBack</code> with an idempotency key,{' '}
            <code>waitFor(&apos;settled&apos;)</code> for three days.
          </p>
        </div>
        <div className="home-card">
          <strong>everseek</strong>
          <p>
            Webhooks write to the journal as the system actor: <code>actorId: null</code>.
          </p>
        </div>
        <div className="home-card">
          <strong>games-platform</strong>
          <p>Taps fan out realtime after commit, so subscribers never hear a rolled-back change.</p>
        </div>
        <div className="home-card">
          <strong>foreman</strong>
          <p>
            Audit log with an atomic staleness check: a stale write returns <code>CommandConflict</code>.
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * The journal chapter. Both simulations start from a finished run (committed panes, a complete `journal_events`
 * table), so the chapter reads in full without JavaScript. The buttons appear once the page is interactive.
 */
export function JournalChapter() {
  const interactive = useHydrated();
  return (
    <section className="home-chapter" aria-label="The journal chapter">
      <div className="home-chapter-head">
        <span>
          <b>Chapter</b> · @arki/journal
        </span>
        <span>packages/journal · every line is copied from a real file</span>
      </div>
      <OneTransaction interactive={interactive} />
      <RefundWorkflow interactive={interactive} />
      <Standing />
    </section>
  );
}
