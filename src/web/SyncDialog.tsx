import { useEffect, useRef, useState } from 'react';
import type { SyncPreview, SyncStatus } from '../shared';
import { api } from './api';
import { Dialog, DialogErrorContext } from './Dialogs';

export function SyncDialog({
  close,
  run,
}: {
  close: () => void;
  run: (operation: () => Promise<unknown>) => Promise<boolean>;
}) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [preview, setPreview] = useState<SyncPreview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [success, setSuccess] = useState(false);
  const active = useRef(false);

  useEffect(() => {
    let cancelled = false;
    api<SyncStatus>('/sync/status').then(
      (value) => {
        if (!cancelled) setStatus(value);
      },
      (error: unknown) => {
        if (!cancelled)
          setError(error instanceof Error ? error.message : 'Cannot load sync status.');
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  async function request(action: 'status' | 'preview' | 'apply', resolution?: 'local' | 'remote') {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError('');
    setSuccess(false);
    setConfirmed(false);
    setPreview(null);
    try {
      if (action === 'status') setStatus(await api<SyncStatus>('/sync/status'));
      else if (action === 'preview') {
        setPreview(
          await api<SyncPreview>('/sync/preview', 'POST', resolution ? { resolution } : {}),
        );
      } else if (preview?.canApply && confirmed) {
        let failure = '';
        const applied = await run(async () => {
          try {
            setStatus(
              await api<SyncStatus>('/sync/apply', 'POST', {
                previewId: preview.previewId,
                confirm: true,
              }),
            );
          } catch (error) {
            failure = `${error instanceof Error ? error.message : 'Sync failed.'} Re-preview before trying again; an upload may already have committed.`;
            throw new Error(failure);
          }
        });
        if (applied) setSuccess(true);
        else
          setError(
            failure ||
              'Sync was not confirmed successful. Re-preview before trying again; an upload may already have committed.',
          );
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Workspace sync failed.');
    } finally {
      active.current = false;
      setBusy(false);
    }
  }

  return (
    <DialogErrorContext value={error}>
      <Dialog
        title="Workspace sync"
        close={() => {
          if (!active.current) close();
        }}
      >
        <div className="workspace-sync" aria-busy={busy}>
          <p>
            Manually sync task state with a private GitHub repository. This is separate from pull
            request refresh. Nothing is applied until you review and confirm.
          </p>
          {!status && !error && <p role="status">Loading sync status...</p>}
          {status && (
            <>
              <dl>
                <dt>Target</dt>
                <dd>
                  {(preview?.target ?? status.target) ? (
                    <code>
                      {(preview?.target ?? status.target)!.repo} /{' '}
                      {(preview?.target ?? status.target)!.branch} /{' '}
                      {(preview?.target ?? status.target)!.path}
                    </code>
                  ) : (
                    'Not configured'
                  )}
                </dd>
                <dt>Last successful sync</dt>
                <dd>{status.lastSync ? new Date(status.lastSync).toLocaleString() : 'Never'}</dd>
                <dt>Local state</dt>
                <dd>{status.dirty ? 'Unsynced local changes' : 'No unsynced local changes'}</dd>
              </dl>
              {status.syncing && (
                <p role="status">
                  A workspace sync is already running. Refresh status before continuing.
                </p>
              )}
              {!status.configured && (
                <section>
                  <h3>Set up workspace sync</h3>
                  <p>
                    Set <code>FOGGY_SYNC_REPO=owner/repo</code> for a private repository and{' '}
                    <code>FOGGY_SYNC_TOKEN</code> in the server environment, then restart the
                    server. Use a dedicated token with Contents read/write access to that
                    repository. There is no fallback to <code>GH_TOKEN</code>; never enter tokens in
                    this dialog.
                  </p>
                  <p>
                    Optional: <code>FOGGY_SYNC_BRANCH</code> defaults to <code>main</code> and{' '}
                    <code>FOGGY_SYNC_PATH</code> defaults to <code>foggybrain/state.json</code>.
                  </p>
                </section>
              )}
            </>
          )}
          {success && (
            <p className="callout" role="status">
              Workspace sync applied successfully.
            </p>
          )}
          {preview && (
            <>
              <h3>Review sync preview</h3>
              {(['local', 'remote'] as const).map((side) => (
                <section key={side} aria-label={`Changes to ${side} state`}>
                  <h3>Changes to {side} state</h3>
                  {preview[`${side}Changes`].length ? (
                    <ul className="sync-changes">
                      {preview[`${side}Changes`].map((change) => (
                        <li key={`${change.collection}/${change.id}`}>
                          <strong>{change.kind}</strong> {change.collection}
                          {change.title && <>: {change.title}</>} <code>{change.id}</code>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>No changes.</p>
                  )}
                </section>
              ))}
              {!!preview.conflicts.length && (
                <section>
                  <h3>Conflicts</h3>
                  <p>
                    Choose which values to use for conflicting fields only. Other changes are still
                    merged by the server.
                  </p>
                  {preview.conflicts.map((conflict) => (
                    <div className="sync-conflict" key={conflict.path}>
                      <strong>{conflict.path}</strong>
                      <dl>
                        {(['base', 'local', 'remote'] as const).map((side) => (
                          <div key={side}>
                            <dt>{side}</dt>
                            <dd>
                              <pre>{JSON.stringify(conflict[side], null, 2)}</pre>
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  ))}
                  <div className="sync-actions">
                    {(['local', 'remote'] as const).map((side) => (
                      <button
                        className="button"
                        key={side}
                        disabled={busy}
                        aria-pressed={preview.resolution === side}
                        onClick={() => void request('preview', side)}
                      >
                        Use {side} for conflicts
                      </button>
                    ))}
                  </div>
                </section>
              )}
              <p>
                Selected conflict resolution: <strong>{preview.resolution ?? 'None'}</strong>
              </p>
              {preview.validationError && (
                <div className="callout warning" role="alert">
                  {preview.validationError}
                </div>
              )}
              {preview.canApply && (
                <label className="sync-confirm">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={busy}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                  I confirm applying these changes to local and remote state.
                </label>
              )}
            </>
          )}
          {busy && <p role="status">Working on workspace sync...</p>}
          <footer>
            <button className="button" disabled={busy} onClick={() => void request('status')}>
              Refresh status
            </button>
            <button
              className="button"
              disabled={busy || !status?.configured || status.syncing}
              onClick={() => void request('preview')}
            >
              Preview sync
            </button>
            {preview && (
              <button
                className="button primary"
                disabled={busy || !preview.canApply || !confirmed}
                onClick={() => void request('apply')}
              >
                Apply sync
              </button>
            )}
          </footer>
        </div>
      </Dialog>
    </DialogErrorContext>
  );
}
