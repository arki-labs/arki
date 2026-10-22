import type { ReactNode } from 'react';
import { useEffect, useReducer } from 'react';

import { cn } from '@arki/ui/cn';

import type { Lit } from './code';
import type { SourceQuote } from './excerpt';
import type { OrderColumn, OrderEvent, OrderRow, PlugState, RunPhase } from './journal-lab';
import { Code } from './code';
import {
  CLAIM_RECEIPT,
  JOURNAL_HEADLINE,
  JOURNAL_PROOFS,
  JOURNAL_VERBS,
  ORDER_ENTITY,
  ORDER_REDUCERS,
  PAY_ORDER,
  REFUND_STEPS,
  WRITE_ORDER,
} from './journal-excerpts';
import {
  actualRow,
  appendable,
  changedColumns,
  drift,
  expectedRow,
  foldOrder,
  handlerRuns,
  JOURNAL_NPM_VERSION,
  ORDER_COLUMNS,
  ORDER_EVENTS,
  ORDER_ID,
  PLUG_START,
  plugReducer,
  refundsMade,
  REPAIR_START,
  repairReducer,
  REPLAY_START,
  replayReducer,
  RUN_ID,
  RUN_START,
  runReducer,
  SIGNAL,
  WEBHOOK_START,
  webhookReducer,
  WORKER_COUNTS,
  WRITE_STEPS,
} from './journal-lab';
import { useHydrated } from './use-hydrated';

/** The five sheets, in reading order: the index, the anchors and the title blocks all read this list. */
const SHEETS = [
  { number: 'J-100', title: 'Your row is its events, replayed' },
  { number: 'J-101', title: 'Pull the plug' },
  { number: 'J-102', title: 'The webhook arrives three times' },
  { number: 'J-103', title: 'Someone edits the database by hand' },
  { number: 'J-104', title: 'A refund that survives a restart' },
] as const;
type Sheet = (typeof SHEETS)[number];
const [J100, J101, J102, J103, J104] = SHEETS;
const anchor = (sheet: Sheet) => sheet.number.toLowerCase();

/** Icon paths, 16×16, drawn as strokes. */
const ICON = {
  add: 'M8 3v10M3 8h10',
  play: 'M4 2l9 6-9 6z',
  plug: 'M5 2v4M11 2v4M3 6h10l-1 4H4zM8 10v4',
  kill: 'M3 3l10 10M13 3L3 13',
  rerun: 'M3 8a5 5 0 0 1 9-3M13 8a5 5 0 0 1-9 3M12 2v3H9M4 14v-3h3',
  send: 'M2 8h9M8 4l4 4-4 4',
  warn: 'M8 2l6 11H2zM8 7v3M8 12v.5',
  edit: 'M3 13l1-4 7-7 3 3-7 7z',
  check: 'M2 8l4 4 8-8',
  erase: 'M3 4h10M6 4V2h4v2M5 4l1 10h4l1-10',
  power: 'M8 2v6M4 5a5.5 5.5 0 1 0 8 0',
  clock: 'M8 4v4l3 2M14 8A6 6 0 1 1 2 8a6 6 0 1 1 12 0',
  race: 'M2 5h8M2 11h8M10 3l3 2-3 2M10 9l3 2-3 2',
  mail: 'M2 4h12v9H2zM2 4l6 5 6-5',
} as const;

function Icon({ name }: Readonly<{ name: keyof typeof ICON }>) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d={ICON[name]} />
    </svg>
  );
}

type ActProps = {
  label: string;
  onClick: () => void;
  icon?: keyof typeof ICON;
  tone?: 'go' | 'cut' | 'quiet';
  pressed?: boolean;
};

function Act({ label, onClick, icon, tone, pressed }: Readonly<ActProps>) {
  return (
    <button className={cn('home-act', tone && `is-${tone}`)} type="button" aria-pressed={pressed} onClick={onClick}>
      {icon === undefined ? null : <Icon name={icon} />}
      {label}
    </button>
  );
}

type JournalSheetProps = {
  sheet: Sheet;
  kicker: ReactNode;
  heading: string;
  /** Title block rows after Sheet and Title, label first. */
  block: readonly (readonly [label: string, value: string])[];
  stamp: string;
  next?: true;
  children: ReactNode;
};

/** One sheet: the drawing on the left, its title block on the right (below it on a narrow chapter). */
function JournalSheet({ sheet, kicker, heading, block, stamp, next, children }: Readonly<JournalSheetProps>) {
  const id = anchor(sheet);
  return (
    <section className="home-jsheet" id={id} aria-labelledby={`${id}-title`}>
      <div className="home-jbody">
        <p className="home-kicker">
          <b>{sheet.number}</b> · {kicker}
        </p>
        <h3 id={`${id}-title`}>{heading}</h3>
        {children}
      </div>
      <aside className="home-jblock" aria-label={`Title block ${sheet.number}`}>
        <table>
          <tbody>
            <tr>
              <th scope="row">Sheet</th>
              <td className="is-big">{sheet.number}</td>
            </tr>
            <tr>
              <th scope="row">Title</th>
              <td>{sheet.title}</td>
            </tr>
            {block.map(([label, value]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td>{value}</td>
              </tr>
            ))}
            <tr>
              <th scope="row">Status</th>
              <td className={cn(next && 'is-next')}>
                {next ? `next · not on npm yet · npm has ${JOURNAL_NPM_VERSION}` : 'in @arki/journal'}
              </td>
            </tr>
          </tbody>
        </table>
        <p className="home-jstamp">{stamp}</p>
      </aside>
    </section>
  );
}

type BenchProps = {
  /** The buttons. Null until the page is interactive: a button that does nothing is worse than none. */
  controls: ReactNode;
  status: string;
  children: ReactNode;
};

/** The lab bench: controls and the status line on the left, the live panes on the right. */
function Bench({ controls, status, children }: Readonly<BenchProps>) {
  return (
    <div className="home-bench">
      <div className="home-ctl">
        {controls}
        <p className="home-status" aria-live="polite">
          {status}
        </p>
      </div>
      <div className="home-bench-out">{children}</div>
    </div>
  );
}

const shortPath = (path: string) => path.replace('packages/journal/', '');

/** "Proof: the test file and line, then its name." */
function Proof({ quotes }: Readonly<{ quotes: readonly SourceQuote[] }>) {
  return (
    <p className="home-note">
      Proof:{' '}
      {quotes.map((quote, index) => (
        <span key={quote.text}>
          {index > 0 ? ' · ' : null}
          <code>
            {shortPath(quote.path)}:{quote.line}
          </code>{' '}
          “{quote.text}”
        </span>
      ))}
      .
    </p>
  );
}

/** One row of the `orders` table, with some cells marked. */
function RowTable({ row, marks = {} }: Readonly<{ row: OrderRow; marks?: Partial<Record<OrderColumn, string>> }>) {
  return (
    <table className="home-rowt">
      <thead>
        <tr>
          <th scope="col">id</th>
          {ORDER_COLUMNS.map(column => (
            <th key={column} scope="col">
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>{ORDER_ID}</td>
          {ORDER_COLUMNS.map(column => (
            <td key={column} className={marks[column]}>
              {row[column]}
            </td>
          ))}
        </tr>
      </tbody>
    </table>
  );
}

const SELECT_ORDER = `select * from orders where id = '${ORDER_ID}'`;

// ── J-100 ──────────────────────────────────────────────────────────────────────────────────────────────────────

const REDUCER_PART = {
  OrderPlaced: 'create',
  OrderPaid: 'paid',
  OrderCancelled: 'cancelled',
} as const satisfies Record<OrderEvent, string>;

function ReplaySheet({ interactive }: Readonly<{ interactive: boolean }>) {
  const [state, send] = useReducer(replayReducer, REPLAY_START);
  const { events } = state;
  const newest = events.length;
  const through = Math.min(state.through ?? newest, newest);
  const live = foldOrder(events);
  const replayed = foldOrder(events, through);
  const last = events.at(-1);
  const changed = changedColumns(events);
  const status =
    newest === 0
      ? 'Append OrderPlaced: the .create reducer builds the row.'
      : through < newest
        ? `Replaying through version ${through} of ${newest}. The live row stays at version ${newest}.`
        : `Version ${newest}. Each event changed the row through its reducer.`;
  const liveNote =
    last === 'OrderPaid'
      ? 'Only status and version changed: .on returned a patch.'
      : last === 'OrderPlaced'
        ? 'Built by .create, in the same transaction as the event.'
        : 'Written in the same transaction as the event.';
  const versions = Array.from({ length: newest + 1 }, (_, version) => version);
  return (
    <JournalSheet
      sheet={J100}
      kicker="the row is a replay"
      heading="Your row is its events, replayed."
      block={[
        ['Drawn from', 'README.md:46, 52, 69–77 (entity) · README.md:366 (replay)'],
        ['Shows', "reducers patch the row in the write's transaction; replay rebuilds any version"],
      ]}
      stamp="construction lines: dashed = not yet committed"
    >
      <p className="home-ctext">
        An entity is a normal Postgres table plus a few small functions called reducers. Each reducer says what one
        event does to the row. Append an event, and its reducer patches the row in the same transaction. The row stays a
        plain table you <code>select</code> from. Like event sourcing, without the complexity.
      </p>
      <Bench
        status={status}
        controls={
          interactive ? (
            <>
              <p className="home-ctl-h">Append an event</p>
              {appendable(events).map(event => (
                <Act
                  key={event}
                  icon="add"
                  tone={event === 'OrderCancelled' ? undefined : 'go'}
                  label={event}
                  onClick={() => send({ type: 'append', event })}
                />
              ))}
              <Act tone="quiet" label="Reset" onClick={() => send({ type: 'reset' })} />
              <p className="home-ctl-h">Time travel</p>
              <div className="home-range">
                <label htmlFor="j-100-through">replay through version {through}</label>
                <input
                  id="j-100-through"
                  type="range"
                  min={0}
                  max={newest}
                  value={through}
                  onChange={event => send({ type: 'through', version: Number(event.target.value) })}
                />
                <div className="home-vrow">
                  {versions.map(version => (
                    <button
                      key={version}
                      className="home-vbtn"
                      type="button"
                      aria-pressed={version === through}
                      aria-label={`Replay through version ${version}`}
                      onClick={() => send({ type: 'through', version })}
                    >
                      v{version}
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : null
        }
      >
        <div className="home-ledger">
          <table>
            <caption>
              <b>journal_events</b> · the history of order {ORDER_ID}
            </caption>
            <thead>
              <tr>
                <th scope="col">seq</th>
                <th scope="col">version</th>
                <th scope="col">type</th>
                <th scope="col">data</th>
              </tr>
            </thead>
            <tbody>
              {newest === 0 ? (
                <tr className="is-empty">
                  <td colSpan={4}>No events yet. Append OrderPlaced.</td>
                </tr>
              ) : (
                events.map((event, index) => (
                  <tr key={index} className={cn(index + 1 > through && 'is-off')}>
                    <td className="home-seq">{42 + index}</td>
                    <td>{index + 1}</td>
                    <td className="home-kind">
                      <span>{event}</span>
                    </td>
                    <td className="home-data">{ORDER_EVENTS[event]}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="home-cols">
          <div
            className={cn('home-pane', live === null ? 'is-empty' : last === 'OrderCancelled' ? '' : 'is-committed')}
          >
            <strong>orders · the live row</strong>
            <span className="home-sql">{SELECT_ORDER}</span>
            {live === null ? (
              newest === 0 ? (
                '(0 rows) · nothing written yet'
              ) : (
                `(0 rows) · the reducer returned null, so the row is gone. Its ${newest} events stay.`
              )
            ) : (
              <RowTable
                row={live}
                marks={Object.fromEntries(
                  ORDER_COLUMNS.filter(column => changed.has(column)).map(column => [column, 'is-hot']),
                )}
              />
            )}
            <small>{liveNote}</small>
          </div>
          <div className={cn('home-pane', replayed === null ? 'is-empty' : 'is-staged')}>
            <strong>
              journal.replay(db, order, &apos;{ORDER_ID}&apos;, {'{'} throughVersion: {through} {'}'})
            </strong>
            <span className="home-sql">the same reducers, folded from nothing, up to that version</span>
            {replayed === null ? (
              through === 0 ? (
                'null · before version 1 there is no row'
              ) : (
                'null · at this version the row was deleted'
              )
            ) : (
              <RowTable row={replayed} />
            )}
            <small>A read, not a write: the live row is untouched · README.md:366</small>
          </div>
        </div>
      </Bench>
      <p className="home-why">
        Why it matters: you get the full history and can rebuild any row at any version, but you still read and query a
        normal table. Sheet J-103 works because of this.
      </p>
      <Code excerpt={ORDER_ENTITY} lit={last === undefined ? {} : { [REDUCER_PART[last]]: 'on' }} />
    </JournalSheet>
  );
}

// ── J-101 ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** One write of four, every 0.85 s: slow enough to pull the plug in the middle. */
const WRITE_STEP_MS = 850;

const WRITE_PANES = {
  event: {
    title: 'journal_events · new row',
    text: 'seq 43 · v2 · OrderPaid · { amount: 4800 }',
    note: 'appended first · write.ts:272',
  },
  row: {
    title: 'orders · the row',
    text: `${ORDER_ID} · status: placed → paid · version 1 → 2`,
    note: ".on(OrderPaid, () => ({ status: 'paid' })) · README.md:76",
  },
  projection: {
    title: 'customer-stats · inline projection',
    text: 'Ran in this transaction. It listens to OrderPlaced only, so OrderPaid leaves placed: 1 as it is.',
    note: 'README.md:93 · write.ts:378',
  },
  job: {
    title: 'journal_jobs · new row',
    text: 'job_c4m · effect: order-mail · event_seq: 43',
    note: "effect 'order-mail' · write.ts:405",
  },
} as const satisfies Record<(typeof WRITE_STEPS)[number], { title: string; text: string; note: string }>;

const JOB_STATE = {
  idle: 'runnable now',
  sent: 'acked: done',
  killed: 'no ack, so the lease runs out: runnable again',
  reran: 'acked on attempt 2: done',
} as const satisfies Record<PlugState['worker'], string>;

function PlugSheet({ interactive }: Readonly<{ interactive: boolean }>) {
  const [state, send] = useReducer(plugReducer, PLUG_START);
  const { phase, written, worker } = state;
  useEffect(() => {
    if (phase !== 'writing') return;
    const timer = setTimeout(() => send('tick'), WRITE_STEP_MS);
    return () => clearTimeout(timer);
  }, [phase, written]);
  const committed = phase === 'committed';
  const counts = WORKER_COUNTS[worker];
  const current = WRITE_STEPS[written - 1];
  const status =
    phase === 'idle'
      ? 'Run payOrder. While the four writes go by, pull the plug.'
      : phase === 'cut'
        ? `Power cut after write ${written} of 4. Nothing exists. Run it again.`
        : phase === 'writing'
          ? `Writing ${written} of 4: the ${current}…`
          : worker === 'idle'
            ? 'Committed. The job is runnable now. Run the worker, or kill it after the send.'
            : worker === 'sent'
              ? 'Email sent and the job acked.'
              : worker === 'killed'
                ? 'The email went out, but the ack never came. The job is runnable again under the same id.'
                : 'Second attempt, same job id, still one email.';
  const writeLit: Readonly<Record<string, Lit>> =
    current === undefined || phase === 'idle' ? {} : { [current]: phase === 'cut' ? 'bad' : 'on' };
  return (
    <JournalSheet
      sheet={J101}
      kicker="all or nothing, then the follow-up work"
      heading="Pull the plug. Nothing is written, or all of it."
      block={[
        ['Drawn from', 'README.md:46, 81–90, 106–114 · write.ts:272–405'],
        ['Proof', 'journal.test.ts:239 · jobs.pg.test.ts:166'],
      ]}
      stamp="order inside the write: event, row, projections, jobs, commit"
    >
      <p className="home-ctext">
        One command, <code>payOrder</code>, makes four writes in one transaction: the event, the row, the inline
        projection, and the job for the email. Cut the power at any point and Postgres never sees a commit, so none of
        the four exist. Let it commit, and only then can a worker pick up the job. The job id is the email&apos;s
        idempotency key, so a worker that dies after sending can run the job again and the inbox still shows one email.
      </p>
      <Bench
        status={status}
        controls={
          interactive ? (
            <>
              {committed ? null : <p className="home-ctl-h">The write</p>}
              {phase === 'idle' || phase === 'cut' ? (
                <Act tone="go" icon="play" label="Run payOrder" onClick={() => send('run')} />
              ) : null}
              {phase === 'writing' ? (
                <Act tone="cut" icon="plug" label="Pull the plug now" onClick={() => send('plug')} />
              ) : null}
              {committed && worker === 'idle' ? (
                <>
                  <p className="home-ctl-h">The worker</p>
                  <Act tone="go" icon="play" label="Run the worker" onClick={() => send('send')} />
                  <Act
                    tone="cut"
                    icon="kill"
                    label="Kill the worker after the email went out"
                    onClick={() => send('kill')}
                  />
                </>
              ) : null}
              {committed && worker === 'killed' ? (
                <>
                  <p className="home-ctl-h">The worker</p>
                  <Act tone="go" icon="rerun" label="Worker restarts, job runs again" onClick={() => send('rerun')} />
                </>
              ) : null}
              <Act tone="quiet" label="Reset" onClick={() => send('reset')} />
            </>
          ) : null
        }
      >
        <ol className="home-flow" aria-label="The writes of one transaction">
          {WRITE_STEPS.map((step, index) => (
            <li
              key={step}
              className={cn(
                committed || (phase === 'writing' && index + 1 < written)
                  ? 'is-done'
                  : phase === 'cut' && index < written
                    ? 'is-dead'
                    : phase === 'writing' && index + 1 === written && 'is-on',
              )}
            >
              {index + 1} {step}
            </li>
          ))}
          <li className={cn(committed && 'is-done')}>commit</li>
        </ol>
        <div className={cn('home-tx', committed ? 'is-committed' : phase === 'cut' && 'is-rolled')}>
          <p className="home-tx-label">
            one transaction · {committed ? 'committed' : phase === 'cut' ? 'never committed' : 'in flight'}
          </p>
          {WRITE_STEPS.map((step, index) => {
            const done = phase === 'writing' && index < written;
            const pane = WRITE_PANES[step];
            return (
              <div key={step} className={cn('home-pane', committed ? 'is-committed' : done ? 'is-staged' : 'is-empty')}>
                <strong>{pane.title}</strong>
                {committed || done ? pane.text : 'nothing'}
                <small>{pane.note}</small>
              </div>
            );
          })}
        </div>
        {phase === 'cut' ? (
          <div className="home-fail">
            <strong>power cut after write {written}</strong>
            Postgres never got a commit. Every pane above is empty again: no event, no row change, no projection write,
            no job. A projection that throws does the same: the whole write rolls back.
          </div>
        ) : null}
        <p className="home-dim">
          <span>after commit · the worker&apos;s side</span>
        </p>
        <div className="home-cols">
          <div
            className={cn(
              'home-pane',
              committed ? (worker === 'sent' || worker === 'reran' ? 'is-ok' : 'is-staged') : 'is-empty',
            )}
          >
            <strong>journal_jobs · job_c4m</strong>
            {committed ? (
              <>
                effect: order-mail · attempts: {counts.attempts}
                <br />
                <span
                  className={cn('home-val', worker === 'killed' ? 'is-red' : worker === 'idle' ? 'is-hot' : 'is-green')}
                >
                  {JOB_STATE[worker]}
                </span>
              </>
            ) : (
              'no row: nothing committed'
            )}
            <small>
              A worker can pick up the job only after the commit. A job row that never committed does not exist.
            </small>
          </div>
          <div className="home-pane">
            <strong>inbox · ana@example.com</strong>
            {counts.emails === 0 || !committed ? (
              'no email yet'
            ) : (
              <span className="home-mail">
                <Icon name="mail" />
                order-paid · {ORDER_ID} · idempotencyKey: job_c4m
              </span>
            )}
            <small>
              {worker === 'reran'
                ? 'Still 1 email after 2 attempts: the provider deduped the second send on its key.'
                : worker === 'killed'
                  ? '1 email. The worker died before it acked the job.'
                  : `${committed ? counts.emails : 0} email`}
            </small>
          </div>
        </div>
        {committed && worker === 'reran' ? (
          <div className="home-okbox">
            <strong>same job id, one email</strong>
            The job ran twice as <code>job_c4m</code>. The mail provider dedupes on that key, so the second send changes
            nothing.
          </div>
        ) : null}
        <Proof quotes={[JOURNAL_PROOFS.throwingProjection, JOURNAL_PROOFS.crashAfterSend]} />
      </Bench>
      <Code excerpt={PAY_ORDER} lit={committed && worker !== 'idle' ? { send: 'on' } : {}} />
      <Code excerpt={WRITE_ORDER} lit={committed ? { job: 'on' } : writeLit} />
    </JournalSheet>
  );
}

// ── J-102 ──────────────────────────────────────────────────────────────────────────────────────────────────────

const REPLY = "{ row: { status: 'paid', version: 2 }, events: [OrderPaid] }";

function WebhookSheet({ interactive }: Readonly<{ interactive: boolean }>) {
  const [state, send] = useReducer(webhookReducer, WEBHOOK_START);
  const { deliveries, conflict } = state;
  const runs = handlerRuns(state);
  const status =
    deliveries === 0
      ? 'Deliver the same webhook three times.'
      : conflict
        ? 'Same key, other body: refused. The first receipt wins.'
        : deliveries === 1
          ? 'First delivery: the command ran once and wrote one event.'
          : `Delivery ${deliveries}: same reply, the handler did not run, nothing written.`;
  return (
    <JournalSheet
      sheet={J102}
      kicker="idempotency receipts"
      heading="The webhook arrives three times. The handler runs once."
      block={[
        ['Drawn from', 'command.ts:24, 28, 76–81, 90–93'],
        ['Proof', 'command.test.ts:593'],
      ]}
      stamp="one receipt per key · insert on conflict do nothing"
    >
      <p className="home-ctext">
        A payment provider sends a webhook again until you answer. Run the command with the event id as its idempotency
        key. The first run claims a receipt row and does the work. Every later run with the same key finds the receipt
        and answers with the stored result. It writes nothing. The same key with a different body is refused as a{' '}
        <code>CommandConflict</code>.
      </p>
      <Bench
        status={status}
        controls={
          interactive ? (
            <>
              <p className="home-ctl-h">Stripe sends evt_1Ab3</p>
              <Act tone="go" icon="send" label="Deliver the webhook" onClick={() => send('deliver')} />
              <Act icon="warn" label="Same key, different body" onClick={() => send('different')} />
              <Act tone="quiet" label="Reset" onClick={() => send('reset')} />
            </>
          ) : null
        }
      >
        <div className="home-panes">
          <div className={cn('home-pane', runs > 0 ? 'is-ok' : 'is-empty')}>
            <strong>handler</strong>
            <span className="home-num">runs: {runs}</span>
            <small>how many times the command body ran</small>
          </div>
          <div className={cn('home-pane', runs > 0 ? 'is-committed' : 'is-empty')}>
            <strong>journal_receipts</strong>
            {runs > 0
              ? `key: 'stripe:evt_1Ab3' · command: 'payOrder' · input: { orderId: '${ORDER_ID}', amount: 4800 } · result: { value: … } · command_id: 'cmd_8d1'`
              : 'no receipt'}
            <small>key · command · input · result · command_id</small>
          </div>
          <div className={cn('home-pane', runs > 0 ? 'is-committed' : 'is-empty')}>
            <strong>journal_events</strong>
            <ul className="home-evlist" aria-label="Events written">
              {runs > 0 ? <li>seq 43 · v2 · OrderPaid · command_id: cmd_8d1</li> : null}
            </ul>
            {runs > 0 ? null : 'no event'}
            <small>one OrderPaid, whatever the delivery count</small>
          </div>
        </div>
        <div className="home-ledger">
          <table>
            <caption>
              <b>replies</b> · what each delivery got back
            </caption>
            <thead>
              <tr>
                <th scope="col">delivery</th>
                <th scope="col">reply</th>
                <th scope="col">how</th>
              </tr>
            </thead>
            <tbody>
              {deliveries === 0 ? (
                <tr className="is-empty">
                  <td colSpan={3}>Nothing delivered yet.</td>
                </tr>
              ) : (
                Array.from({ length: deliveries }, (_, index) => (
                  <tr key={index}>
                    <td className="home-seq">{index + 1}</td>
                    <td>{REPLY}</td>
                    <td className="home-data">
                      {index === 0
                        ? 'the handler ran, the receipt was written'
                        : 'from the receipt: the handler did not run, nothing written'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {conflict ? (
          <div className="home-fail">
            <strong>returned, not thrown</strong>
            CommandConflict({'{'} detail: &apos;the idempotency key was used by command &quot;payOrder&quot; with a
            different input&apos; {'}'})
            <br />
            The receipt stays as it was. Nothing is written.
          </div>
        ) : null}
        <Proof quotes={[JOURNAL_PROOFS.receiptReplay]} />
      </Bench>
      <Code excerpt={CLAIM_RECEIPT} lit={conflict ? { conflict: 'bad' } : deliveries > 0 ? { claim: 'on' } : {}} />
    </JournalSheet>
  );
}

// ── J-103 ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** A README sentence with its `code` spans set as code. */
function QuoteText({ text }: Readonly<{ text: string }>) {
  return text.split('`').map((piece, index) => (index % 2 === 1 ? <code key={index}>{piece}</code> : piece));
}

function RepairSheet({ interactive }: Readonly<{ interactive: boolean }>) {
  const [state, send] = useReducer(repairReducer, REPAIR_START);
  const { edits, verified, forgotten } = state;
  const drifted = drift(state);
  const expected = expectedRow(state);
  const actual = actualRow(state);
  const status =
    verified === 'drift'
      ? `${drifted.length === 1 ? '1 column' : `${drifted.length} columns`} drifted. Repair writes the folded row back and queues no job.`
      : verified === 'ok'
        ? forgotten
          ? 'Green after forget: the erased history still rebuilds the row.'
          : 'The row equals its replay.'
        : drifted.length > 0
          ? 'The row was changed by hand. Verify it.'
          : 'Edit a cell by hand, then verify.';
  const marks = Object.fromEntries(
    ORDER_COLUMNS.map(column => [
      column,
      drifted.includes(column) ? 'is-red' : forgotten && column === 'customer_id' ? 'is-hot' : '',
    ]),
  );
  return (
    <JournalSheet
      sheet={J103}
      kicker="verify, repair, forget"
      heading="Someone edits the database by hand. Prove it, fix it, forget what you must."
      block={[
        ['Drawn from', 'README.md:46, 73–77, 260, 262, 366'],
        ['Proof', 'journal.test.ts:577 · journal.test.ts:682'],
      ]}
      stamp="depends on J-100: a row that can be rebuilt can be checked"
    >
      <p className="home-ctext">
        Because the row is a replay of its events (sheet J-100), the journal can always check it. <code>verify</code>{' '}
        folds the events and compares, column by column. <code>repair</code> writes the folded row back, and queues no
        job. <code>forget</code> rewrites the events that hold personal data to their erased form, stamps them, and
        repairs the row so it matches. The history still replays.
      </p>
      <Bench
        status={status}
        controls={
          interactive ? (
            <>
              <p className="home-ctl-h">Edit by hand</p>
              <Act
                icon="edit"
                label="set status = 'shipped'"
                pressed={edits.status}
                onClick={() => send({ type: 'edit', column: 'status' })}
              />
              <Act
                icon="edit"
                label="set total = 1"
                pressed={edits.total}
                onClick={() => send({ type: 'edit', column: 'total' })}
              />
              <p className="home-ctl-h">Then</p>
              <Act
                tone="go"
                icon="check"
                label={`journal.verify(db, order, '${ORDER_ID}')`}
                onClick={() => send({ type: 'verify' })}
              />
              {verified === 'drift' ? (
                <Act
                  tone="go"
                  icon="rerun"
                  label={`journal.repair(db, order, '${ORDER_ID}')`}
                  onClick={() => send({ type: 'repair' })}
                />
              ) : null}
              {forgotten ? null : (
                <Act
                  icon="erase"
                  label={`journal.forget(db, order, '${ORDER_ID}')`}
                  onClick={() => send({ type: 'forget' })}
                />
              )}
              <Act tone="quiet" label="Reset" onClick={() => send({ type: 'reset' })} />
            </>
          ) : null
        }
      >
        <div className="home-cols">
          <div className={cn('home-pane', verified === 'drift' ? 'is-bad' : verified === 'ok' && 'is-ok')}>
            <strong>orders · the live row</strong>
            <span className="home-sql">{SELECT_ORDER}</span>
            <RowTable row={actual} marks={marks} />
            <small>
              {drifted.length > 0
                ? 'Edited by hand with a plain UPDATE. No event says so.'
                : forgotten
                  ? "customer_id is '' now: repaired from the erased history."
                  : 'Matches its history.'}
            </small>
          </div>
          <div className={cn('home-pane', verified === 'drift' ? 'is-bad' : verified === 'ok' && 'is-ok')}>
            <strong>verify · expected and actual</strong>
            {verified === 'unchecked' ? 'not checked yet' : null}
            {verified === 'ok' ? (
              <>
                <span className="home-val is-green">{'{ ok: true }'}</span> the row equals its replay, column by column
              </>
            ) : null}
            {verified === 'drift' ? (
              <table className="home-rowt">
                <thead>
                  <tr>
                    <th scope="col">column</th>
                    <th scope="col">expected</th>
                    <th scope="col">actual</th>
                  </tr>
                </thead>
                <tbody>
                  {drifted.map(column => (
                    <tr key={column}>
                      <td>{column}</td>
                      <td>{expected[column]}</td>
                      <td className="is-red">{actual[column]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            <small>
              {verified === 'drift'
                ? 'expected: the reducers folded over journal_events'
                : verified === 'ok'
                  ? 'README.md:366 · verify(db, entity, id)'
                  : 'press verify'}
            </small>
          </div>
        </div>
        <div className="home-ledger">
          <table>
            <caption>
              <b>journal_events</b> · history of {ORDER_ID} · the source of truth
            </caption>
            <thead>
              <tr>
                <th scope="col">seq</th>
                <th scope="col">version</th>
                <th scope="col">type</th>
                <th scope="col">data</th>
                <th scope="col">erased_at</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="home-seq">42</td>
                <td>1</td>
                <td className="home-kind">
                  <span className={cn(forgotten && 'is-erased')}>OrderPlaced</span>
                </td>
                <td className="home-data">
                  {forgotten ? "{ customerId: '', total: 4800 }" : ORDER_EVENTS.OrderPlaced}
                </td>
                <td className="home-data">{forgotten ? '2026-10-21 14:02' : 'null'}</td>
              </tr>
              <tr>
                <td className="home-seq">43</td>
                <td>2</td>
                <td className="home-kind">
                  <span>OrderPaid</span>
                </td>
                <td className="home-data">{ORDER_EVENTS.OrderPaid}</td>
                <td className="home-data">null</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="home-note">
          The README&apos;s own OrderPlaced has no erased form. Here it is given one that blanks <code>customerId</code>
          , the way README.md:260 shows.
        </p>
        <Proof quotes={[JOURNAL_PROOFS.verifyRepair, JOURNAL_PROOFS.forget]} />
      </Bench>
      <Code excerpt={ORDER_REDUCERS} />
      <div className="home-quotes">
        {JOURNAL_VERBS.map(quote => (
          <blockquote key={quote.line}>
            <p>
              <QuoteText text={quote.text} />
            </p>
            <footer>
              {shortPath(quote.path)}:{quote.line}
            </footer>
          </blockquote>
        ))}
      </div>
    </JournalSheet>
  );
}

// ── J-104 ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** One step every 1.1 s: long enough to restart the server while payBack runs. */
const RUN_STEP_MS = 1100;

const RUN_STATUS = {
  idle: 'Start the refund. While payBack runs, restart the server.',
  hold: 'Step hold is running…',
  payBack: `Step payBack is running with key '${RUN_ID}:payBack:do'…`,
  parked: 'Parked on settled. The run and its timer are rows in the database now, so a restart changes nothing.',
  stuck:
    "No signal in 3 days. onTimeout is 'fail' and onDeadStep is 'wait' by default, so the run is stuck until an operator retries the step, gives its result, or cancels the run.",
  completed: 'Done. One signal, one finish, one refund at the provider.',
  cancelled: 'Cancelled. The undo functions ran newest first.',
} as const satisfies Record<RunPhase, string>;

/** The nodes of the refund, and the phase where each one is the current node. */
const RUN_NODES = [
  ['hold', 'hold'],
  ['payBack', 'payBack'],
  ['settled · waitFor 3d', 'parked'],
  ['finish', 'completed'],
] as const satisfies readonly (readonly [label: string, phase: RunPhase])[];
const NODE_ORDER: readonly RunPhase[] = RUN_NODES.map(([, phase]) => phase);

const REFUND_LIT = {
  idle: {},
  hold: { hold: 'on' },
  payBack: { payBack: 'on' },
  parked: { wait: 'on' },
  stuck: { wait: 'bad' },
  completed: {},
  cancelled: { undo: 'on' },
} as const satisfies Record<RunPhase, Readonly<Record<string, Lit>>>;

function nodeClass(phase: RunPhase, index: number): string | false {
  if (phase === 'completed') return 'is-done';
  if (phase === 'cancelled' || phase === 'stuck') return index < 2 ? 'is-done' : 'is-dead';
  const current = NODE_ORDER.indexOf(phase);
  if (current === -1) return false;
  return index < current ? 'is-done' : index === current && 'is-on';
}

function RefundSheet({ interactive }: Readonly<{ interactive: boolean }>) {
  const [state, send] = useReducer(runReducer, RUN_START);
  const { phase, rows, calls } = state;
  useEffect(() => {
    if (phase !== 'hold' && phase !== 'payBack') return;
    const timer = setTimeout(() => send('tick'), RUN_STEP_MS);
    return () => clearTimeout(timer);
  }, [phase, rows.length]);
  return (
    <JournalSheet
      sheet={J104}
      next
      kicker={
        <>
          durable workflow ·{' '}
          <span className="home-badge">
            <Icon name="clock" />
            next · not on npm yet · latest published is {JOURNAL_NPM_VERSION}
          </span>
        </>
      }
      heading="A refund that survives a restart and undoes itself."
      block={[
        ['Drawn from', 'README.md:821, 848–857'],
        ['Proof', 'workflow/runner.test.ts:459 · compensation.test.ts:311, 399 · wait.pg.test.ts:155'],
      ]}
      stamp="RunStarted, NodeScheduled, NodeCompleted, NodeFailed, Parked, SignalReceived, TimerFired, CancelRequested, CompensationStarted, RunCompleted, RunCancelled: the real event names"
    >
      <p className="home-ctext">
        A workflow is a list of steps. Every step writes a checkpoint event before and after it runs. Restart the server
        in the middle of a step and the run goes on from the last checkpoint. The step runs again with the same key, so
        the provider makes one refund. The run then waits until the provider&apos;s webhook sends a signal, or three
        days pass. Cancel it and the undo functions run, newest first.
      </p>
      <Bench
        status={RUN_STATUS[phase]}
        controls={
          interactive ? (
            <>
              <p className="home-ctl-h">Drive the run</p>
              {phase === 'idle' ? (
                <Act tone="go" icon="play" label="Start the refund" onClick={() => send('start')} />
              ) : null}
              {phase === 'payBack' ? (
                <Act tone="cut" icon="power" label="Restart the server now" onClick={() => send('restart')} />
              ) : null}
              {phase === 'parked' ? (
                <>
                  <Act tone="go" icon="send" label="Provider webhook: settled" onClick={() => send('signal')} />
                  <Act icon="clock" label="Wait 3 days" onClick={() => send('wait')} />
                  <Act icon="race" label="Signal and timeout at once" onClick={() => send('race')} />
                </>
              ) : null}
              {phase === 'parked' || phase === 'stuck' ? (
                <Act tone="cut" icon="kill" label="Cancel the run" onClick={() => send('cancel')} />
              ) : null}
              <Act tone="quiet" label="Reset" onClick={() => send('reset')} />
            </>
          ) : null
        }
      >
        <ol className="home-flow" aria-label="Nodes of the workflow">
          {RUN_NODES.map(([label], index) => (
            <li key={label} className={cn(nodeClass(phase, index))}>
              {label}
            </li>
          ))}
        </ol>
        <div className="home-ledger">
          <table>
            <caption>
              <b>journal_events</b> · the run&apos;s history, one row per checkpoint
            </caption>
            <thead>
              <tr>
                <th scope="col">seq</th>
                <th scope="col">type</th>
                <th scope="col">node</th>
                <th scope="col">note</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr className="is-empty">
                  <td colSpan={4}>No run yet. Start the refund.</td>
                </tr>
              ) : (
                rows.map((row, index) =>
                  row.type === null ? (
                    <tr key={index} className="is-srv">
                      <td colSpan={4}>{row.note}</td>
                    </tr>
                  ) : (
                    <tr key={index}>
                      <td className="home-seq">
                        {70 + rows.slice(0, index).filter(earlier => earlier.type !== null).length}
                      </td>
                      <td className="home-kind">
                        <span className="is-run">{row.type}</span>
                      </td>
                      <td>{row.node}</td>
                      <td className="home-data">{row.note}</td>
                    </tr>
                  ),
                )
              )}
            </tbody>
          </table>
        </div>
        <div className="home-cols">
          <div className="home-pane">
            <strong>provider · payments</strong>
            hold calls: {calls.hold} · refund calls: {calls.refund} · release calls: {calls.release}
            <br />
            refunds made: <span className="home-val is-hot">{refundsMade(state)}</span>
            <small>Every try of payBack sends the same key, so the provider makes one refund.</small>
          </div>
          <div className={cn('home-pane', phase === 'cancelled' ? 'is-bad' : 'is-empty')}>
            <strong>compensation · newest first</strong>
            {phase === 'cancelled' ? (
              <ol className="home-undo">
                <li>payBack · no undo · kept in residual for an operator</li>
                <li>hold · undo ran · payments.release(&apos;hold_2q7&apos;)</li>
              </ol>
            ) : (
              'not running'
            )}
            <small>A step without undo is skipped, and its work stays done.</small>
          </div>
        </div>
        <p className="home-note">
          The run&apos;s signal is <code>{SIGNAL}</code>, the one named in the code below.
        </p>
        <Proof
          quotes={[
            JOURNAL_PROOFS.stepRerun,
            JOURNAL_PROOFS.cancelUndoes,
            JOURNAL_PROOFS.deadStepWaits,
            JOURNAL_PROOFS.signalWins,
          ]}
        />
      </Bench>
      <Code excerpt={REFUND_STEPS} lit={REFUND_LIT[phase]} />
    </JournalSheet>
  );
}

type JournalChapterProps = {
  /** Draw the chapter's headline. The homepage floor already has it as its own heading, so it passes false. */
  headline: boolean;
};

/**
 * The journal chapter: five lab benches, J-100 to J-104. Each bench starts from a finished run, so it reads in full
 * without JavaScript; the buttons appear once the page is interactive.
 */
export function JournalChapter({ headline }: Readonly<JournalChapterProps>) {
  const interactive = useHydrated();
  return (
    <section className="home-chapter" aria-label="The journal chapter">
      <div className="home-chapter-head">
        <span>
          <b>Chapter</b> · @arki/journal
        </span>
        <span>sheets J-100 to J-104 · every code line is copied from a real file</span>
      </div>
      <div className="home-jhero">
        <div className="home-jhero-in">
          {headline ? (
            <>
              <p className="home-kicker">
                <b>Chapter</b> · five things you can try
              </p>
              <p className="home-jlead">{JOURNAL_HEADLINE}</p>
            </>
          ) : null}
          <p className="home-jpromise">
            Every change is saved with its history and its follow-up work in one go, and you can always prove the table
            is right.
          </p>
          <nav className="home-jindex" aria-label="Sheets in this chapter">
            {SHEETS.map(sheet => (
              <a key={sheet.number} href={`#${anchor(sheet)}`}>
                <b>{sheet.number}</b> {sheet.title}
              </a>
            ))}
          </nav>
          <p className="home-sim">Simulated in your browser. The code is real.</p>
        </div>
      </div>
      <ReplaySheet interactive={interactive} />
      <PlugSheet interactive={interactive} />
      <WebhookSheet interactive={interactive} />
      <RepairSheet interactive={interactive} />
      <RefundSheet interactive={interactive} />
    </section>
  );
}
