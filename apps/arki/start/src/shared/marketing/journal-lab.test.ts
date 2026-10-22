import { describe, expect, it } from 'vitest';

import type { PlugAction, RunAction, WebhookAction } from './journal-lab';
import {
  changedColumns,
  drift,
  expectedRow,
  foldOrder,
  handlerRuns,
  PLUG_START,
  plugReducer,
  refundsMade,
  REPAIR_START,
  repairReducer,
  RUN_START,
  runReducer,
  WEBHOOK_START,
  webhookReducer,
  WORKER_COUNTS,
} from './journal-lab';

const play = <S, A>(reducer: (state: S, action: A) => S, start: S, actions: readonly A[]): S =>
  actions.reduce((state, action) => reducer(state, action), start);

describe('J-100: the row is its events, replayed', () => {
  // WHY: the sheet's claim is that any version can be rebuilt from the events alone.
  it('replays through an older version without touching the newest row', () => {
    const events = ['OrderPlaced', 'OrderPaid'] as const;
    expect(foldOrder(events, 1)).toMatchObject({ status: 'placed', version: '1' });
    expect(foldOrder(events)).toMatchObject({ status: 'paid', version: '2' });
    expect(foldOrder(events, 0)).toBeNull();
  });

  // WHY: `.on` returns a patch, so paying must change only status and version, and a cancel deletes the row.
  it('a patch changes only its columns; null deletes the row', () => {
    expect([...changedColumns(['OrderPlaced', 'OrderPaid'])]).toEqual(['status', 'version']);
    expect(foldOrder(['OrderPlaced', 'OrderPaid', 'OrderCancelled'])).toBeNull();
  });
});

describe('J-101: pull the plug', () => {
  const writeAll: readonly PlugAction[] = ['run', 'tick', 'tick', 'tick', 'tick'];

  // WHY: all or nothing: a cut before the commit leaves no committed write, so no job a worker could pick up.
  it('a cut mid-write never commits', () => {
    const cut = play(plugReducer, PLUG_START, ['reset', 'run', 'tick', 'plug', 'tick']);
    expect(cut.phase).toBe('cut');
    expect(cut.written).toBe(2);
  });

  // WHY: the job is runnable only after all four writes and the commit.
  it('commits after the fourth write', () => {
    expect(play(plugReducer, PLUG_START, writeAll.slice(0, 4)).phase).toBe('writing');
    expect(play(plugReducer, PLUG_START, writeAll).phase).toBe('committed');
  });

  // WHY: a worker killed after the send runs the job again under the same id, and the inbox still has one email.
  it('a rerun after a kill makes two attempts and one email', () => {
    const state = play(plugReducer, PLUG_START, [...writeAll, 'kill', 'rerun']);
    expect(WORKER_COUNTS[state.worker]).toEqual({ attempts: 2, emails: 1 });
  });
});

describe('J-102: the webhook arrives three times', () => {
  // WHY: the receipt makes repeats answer from storage; the handler body must run exactly once.
  it('three deliveries run the handler once', () => {
    const state = play(webhookReducer, WEBHOOK_START, ['reset', 'deliver', 'deliver', 'deliver'] as const);
    expect(state.deliveries).toBe(3);
    expect(handlerRuns(state)).toBe(1);
  });

  it('the same key with another body is a conflict, not a second run', () => {
    const actions: readonly WebhookAction[] = ['reset', 'deliver', 'different'];
    const state = play(webhookReducer, WEBHOOK_START, actions);
    expect(state.conflict).toBe(true);
    expect(handlerRuns(state)).toBe(1);
  });
});

describe('J-103: verify, repair, forget', () => {
  // WHY: verify compares the table with its replay; a hand edit must show up as drift until repair.
  it('verify finds the hand edit, repair clears it', () => {
    expect(drift(REPAIR_START)).toEqual(['status']);
    const repaired = repairReducer(REPAIR_START, { type: 'repair' });
    expect(drift(repaired)).toEqual([]);
    expect(repairReducer(repaired, { type: 'verify' }).verified).toBe('ok');
  });

  // WHY: after forget, the erased history still rebuilds the row, so verify stays green.
  it('forget blanks the personal column and verify stays green', () => {
    const forgotten = repairReducer(REPAIR_START, { type: 'forget' });
    expect(expectedRow(forgotten).customer_id).toBe("''");
    expect(repairReducer(forgotten, { type: 'verify' }).verified).toBe('ok');
  });
});

describe('J-104: the refund workflow', () => {
  const toParked: readonly RunAction[] = ['reset', 'start', 'tick', 'tick'];

  // WHY: a restart during payBack makes a second call with the same key; the provider must still make one refund.
  it('a restart during payBack calls twice and refunds once', () => {
    const state = play(runReducer, RUN_START, ['reset', 'start', 'tick', 'restart', 'tick']);
    expect(state.phase).toBe('parked');
    expect(state.calls.refund).toBe(2);
    expect(refundsMade(state)).toBe(1);
  });

  // WHY: with the README's defaults a timeout does not compensate: the run waits for an operator.
  it('three days without a signal leave the run stuck, and a cancel then undoes hold', () => {
    const stuck = play(runReducer, RUN_START, [...toParked, 'wait']);
    expect(stuck.phase).toBe('stuck');
    expect(stuck.rows.map(row => row.type).slice(-2)).toEqual(['TimerFired', 'NodeFailed']);
    const cancelled = runReducer(stuck, 'cancel');
    expect(cancelled.phase).toBe('cancelled');
    expect(cancelled.calls.release).toBe(1);
  });

  // WHY: when signal and timeout race, exactly one wins and the timer writes nothing.
  it('signal and timeout at once: one signal, no timer row', () => {
    const state = play(runReducer, RUN_START, [...toParked, 'race']);
    const types = state.rows.map(row => row.type);
    expect(types.filter(type => type === 'SignalReceived')).toHaveLength(1);
    expect(types).not.toContain('TimerFired');
    expect(types.at(-1)).toBe('RunCompleted');
  });
});
