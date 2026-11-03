import { isFailure } from '@arki/failure';
import type { OfflineQueueFailure } from '../mutations/failures.js';

import type { ReactNode } from 'react';
import { useState, useEffect } from 'react';
import { useOnlineStatus } from '../status/useOnlineStatus.js';
import { useOfflineQueueOptional } from '../mutations/OfflineQueueProvider.js';
import type { QueuedMutation } from '../mutations/queue.js';

/**
 * Floating debug panel for inspecting the offline mutation queue.
 *
 * Rendered only in development builds (guarded by `import.meta.env.DEV`).
 * In production, the component returns null immediately — tree-shaking
 * eliminates it from the bundle entirely.
 */
export function OfflineDevPanel(): ReactNode {
  // Gate: no-op in production. Vite replaces import.meta.env.DEV at build time.
  // eslint-disable-next-line turbo/no-undeclared-env-vars -- DEV is a Vite build-time constant, not a Turbo env var
  if (!import.meta.env.DEV) return null;

  return <DevPanelImpl />;
}

function DevPanelImpl(): ReactNode {
  const [failure, setFailure] = useState<OfflineQueueFailure | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [deadLettered, setDeadLettered] = useState<readonly QueuedMutation[]>([]);
  const { online } = useOnlineStatus();
  const queueCtx = useOfflineQueueOptional();

  useEffect(() => {
    if (!queueCtx) return;
    const { queue } = queueCtx;

    const refresh = (): void => {
      void queue.deadLetter.list().then(result => {
        if (isFailure(result)) setFailure(result);
        else { setDeadLettered(result); setFailure(null); }
      });
    };

    refresh();

    const unsub = queue.subscribe(() => {
      refresh();
    });

    return unsub;
  }, [queueCtx]);

  const status = queueCtx?.queue.status();

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 12,
        right: 12,
        zIndex: 9999,
        fontFamily: 'monospace',
        fontSize: 12,
      }}
    >
      <button
        onClick={() => setIsOpen((v) => !v)}
        style={{
          background: online ? '#166534' : '#991b1b',
          color: '#fff',
          border: 'none',
          borderRadius: 6,
          padding: '4px 10px',
          cursor: 'pointer',
        }}
      >
        offline {online ? '✓' : '✗'}
        {status && status.queued > 0 ? ` · ${status.queued}q` : ''}
        {status && status.deadLettered > 0 ? ` · ${status.deadLettered}dl` : ''}
      </button>

      {isOpen && (
        <div
          style={{
            background: '#1c1c1e',
            color: '#e5e5ea',
            borderRadius: 8,
            padding: 12,
            marginTop: 6,
            minWidth: 280,
            maxHeight: 400,
            overflowY: 'auto',
            boxShadow: '0 4px 24px rgba(0,0,0,.5)',
          }}
        >
          <div style={{ marginBottom: 8, fontWeight: 'bold' }}>
            Offline Dev Panel
          </div>
          <div>
            <strong>Status:</strong> {online ? '🟢 online' : '🔴 offline'}
          </div>
          {status && (
            <div>
              <strong>Queue:</strong> {status.queued} queued · {status.sending ? 'sending…' : 'idle'} · {status.deadLettered} dead-lettered
            </div>
          )}

          {(failure ?? status?.failure) && <div role="alert">{(failure ?? status?.failure)?.message}</div>}

          {deadLettered.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <strong>Dead-letter:</strong>
              {deadLettered.map((m) => (
                <div key={m.id} style={{ fontSize: 11, marginTop: 4, opacity: 0.8 }}>
                  {m.procedurePath.join('.')} — {m.lastError?.message ?? 'unknown error'}
                  {queueCtx && (
                    <span>
                      {' '}
                      <button
                        style={{ fontSize: 10, cursor: 'pointer', marginLeft: 4 }}
                        onClick={() => void queueCtx.queue.deadLetter.retry(m.id).then(result => setFailure(isFailure(result) ? result : null))}
                      >
                        retry
                      </button>
                      <button
                        style={{ fontSize: 10, cursor: 'pointer', marginLeft: 4 }}
                        onClick={() => void queueCtx.queue.deadLetter.discard(m.id).then(result => setFailure(isFailure(result) ? result : null))}
                      >
                        discard
                      </button>
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {!queueCtx && (
            <div style={{ marginTop: 8, opacity: 0.6, fontSize: 11 }}>
              No OfflineQueueProvider in tree — queue features unavailable.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
