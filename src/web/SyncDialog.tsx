import { useEffect, useRef, useState } from 'react';
import type { SyncPreview, SyncStatus, Workspace } from '../shared';
import type { WorkspaceApi } from './api';
import { Dialog, DialogErrorContext } from './Dialogs';

export function SyncDialog({
  close,
  run,
  api,
  workspace,
  initialPreview = false,
}: {
  api: WorkspaceApi;
  workspace: Workspace;
  initialPreview?: boolean;
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
  const generation = useRef(0);
  const previewOnMount = useRef(initialPreview);

  useEffect(() => {
    const current = ++generation.current;
    active.current = false;
    setBusy(false);
    setStatus(null);
    setPreview(null);
    setConfirmed(false);
    setError('');
    setSuccess(false);
    api<SyncStatus>('/sync/status').then(
      (value) => {
        if (generation.current !== current) return;
        setStatus(value);
        if (previewOnMount.current) {
          previewOnMount.current = false;
          if (workspace.type === 'cloud' && value.configured && !value.syncing)
            void request('preview');
        }
      },
      (error: unknown) => {
        if (generation.current === current)
          setError(error instanceof Error ? error.message : 'Cannot load sync status.');
      },
    );
    return () => {
      generation.current++;
    };
  }, [api, workspace.id, workspace.type]);

  async function request(action: 'status' | 'preview' | 'apply', resolution?: 'local' | 'remote') {
    if (active.current) return;
    const current = ++generation.current;
    const isCurrent = () => generation.current === current;
    active.current = true;
    setBusy(true);
    setError('');
    setSuccess(false);
    setConfirmed(false);
    setPreview(null);
    try {
      if (action === 'status') {
        const value = await api<SyncStatus>('/sync/status');
        if (isCurrent()) setStatus(value);
      } else if (action === 'preview') {
        const value = await api<SyncPreview>(
          '/sync/preview',
          'POST',
          resolution ? { resolution } : {},
        );
        if (isCurrent()) setPreview(value);
      } else if (preview?.canApply && confirmed) {
        let failure = '';
        const applied = await run(async () => {
          try {
            const value = await api<SyncStatus>('/sync/apply', 'POST', {
              previewId: preview.previewId,
              confirm: true,
            });
            if (isCurrent()) setStatus(value);
          } catch (error) {
            failure = `${error instanceof Error ? error.message : 'Sync failed.'} Re-preview before trying again; an upload may already have committed.`;
            throw new Error(failure);
          }
        });
        if (!isCurrent()) return;
        if (applied) setSuccess(true);
        else
          setError(
            failure ||
              'Sync was not confirmed successful. Re-preview before trying again; an upload may already have committed.',
          );
      }
    } catch (error) {
      if (isCurrent()) setError(error instanceof Error ? error.message : 'Workspace sync failed.');
    } finally {
      if (isCurrent()) {
        active.current = false;
        setBusy(false);
      }
    }
  }

  return (
    <DialogErrorContext value={error}>
      <Dialog
        title={workspace.type === 'cloud' ? 'Workspace sync' : 'Local workspace'}
        close={() => {
          if (!active.current) close();
        }}
      >
        <div className="workspace-sync" aria-busy={busy}>
          {workspace.type === 'local' ? (
            <p>
              This is a local workspace, stored on your device. Use Connect to cloud in the
              workspace controls to configure manual sync. Your existing tasks stay here.
            </p>
          ) : (
            <p>
              Manually sync task state with a private GitHub repository. This is separate from pull
              request refresh. Nothing is applied until you review and confirm.
            </p>
          )}
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
                <dd>
                  {workspace.type === 'local'
                    ? 'Stored locally'
                    : status.dirty
                      ? 'Unsynced local changes'
                      : 'No unsynced local changes'}
                </dd>
              </dl>
              {status.syncing && (
                <p role="status">
                  A workspace sync is already running. Refresh status before continuing.
                </p>
              )}
              {!status.configured && workspace.type === 'cloud' && (
                <section>
                  <h3>Set up workspace sync</h3>
                  <p>
                    Configure{' '}
                    {workspace.credential === 'github'
                      ? 'GH_TOKEN, GITHUB_TOKEN, or gh auth token'
                      : 'FOGGY_SYNC_TOKEN'}{' '}
                    on the server with Contents read/write access to the selected private
                    repository, then restart. Never enter tokens in this dialog.
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
              disabled={busy || workspace.type === 'local' || !status?.configured || status.syncing}
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
