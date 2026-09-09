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
  const [mode, setMode] = useState<'merge' | 'revert' | null>(null);
  const hasChanges = !!preview && !!(preview.localChanges.length || preview.remoteChanges.length);
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
    setMode(null);
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

  async function request(
    action: 'status' | 'preview' | 'apply',
    resolution?: 'local' | 'remote',
    requestedMode: 'merge' | 'revert' = 'merge',
  ) {
    if (active.current) return;
    const current = ++generation.current;
    const isCurrent = () => generation.current === current;
    active.current = true;
    setBusy(true);
    setError('');
    setSuccess(false);
    setConfirmed(false);
    setPreview(null);
    if (action === 'preview') setMode(requestedMode);
    const retryWarning =
      preview?.mode === 'revert'
        ? 'Re-preview before trying again; local state may already have been replaced. Revert never writes to GitHub.'
        : 'Re-preview before trying again; an upload may already have committed.';
    try {
      if (action === 'status') {
        const value = await api<SyncStatus>('/sync/status');
        if (isCurrent()) setStatus(value);
      } else if (action === 'preview') {
        const value = await api<SyncPreview>(
          '/sync/preview',
          'POST',
          requestedMode === 'revert' ? { mode: 'revert' } : resolution ? { resolution } : {},
        );
        if (isCurrent()) setPreview(value);
      } else if (preview?.canApply && hasChanges && confirmed) {
        let failure = '';
        const applied = await run(async () => {
          try {
            const value = await api<SyncStatus>('/sync/apply', 'POST', {
              previewId: preview.previewId,
              confirm: true,
            });
            if (isCurrent()) setStatus(value);
          } catch (error) {
            failure = `${error instanceof Error ? error.message : 'Sync failed.'} ${retryWarning}`;
            throw new Error(failure);
          }
        });
        if (!isCurrent()) return;
        if (applied) setSuccess(true);
        else setError(failure || `Sync was not confirmed successful. ${retryWarning}`);
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
        key={mode ?? 'options'}
        title={
          workspace.type === 'local'
            ? 'Local workspace'
            : mode === 'revert'
              ? 'Reset to origin'
              : mode === 'merge'
                ? 'Push to origin'
                : 'Workspace sync'
        }
        danger={mode === 'revert'}
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
          ) : mode === 'revert' ? (
            <p>
              Replace this workspace with origin. Review what will be discarded before confirming.
              This never writes to GitHub.
            </p>
          ) : mode === 'merge' ? (
            <p>
              Publish local changes to origin, merging any incoming changes into this workspace.
              Review both sides before confirming.
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
                  <span
                    className={`sync-state ${workspace.type === 'local' ? 'sync-state-local' : status.dirty ? 'sync-state-dirty' : 'sync-state-clean'}`}
                  >
                    {workspace.type === 'local'
                      ? 'Stored locally'
                      : status.dirty
                        ? 'Unsynced local changes'
                        : 'No unsynced local changes'}
                  </span>
                </dd>
              </dl>
              {status.syncing && (
                <p className="sync-state sync-state-running" role="status">
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
            <p className="callout sync-state-clean" role="status">
              {mode === 'revert'
                ? 'Workspace reverted to origin successfully.'
                : 'Workspace sync applied successfully.'}
            </p>
          )}
          {preview && (
            <>
              <h3>
                {preview.mode === 'revert' ? 'Review reset to origin' : 'Review push to origin'}
              </h3>
              {preview.mode === 'revert' && (
                <p className="callout warning">
                  This discards unsynced local tasks and relationships, replacing local state from
                  the configured repository, branch, and path shown above. An automatic local backup
                  is created before replacement. Revert never writes to GitHub.
                </p>
              )}
              {(preview.mode === 'revert'
                ? (['local'] as const)
                : (['local', 'remote'] as const)
              ).map((side) => (
                <section key={side} aria-label={`Changes to ${side} state`}>
                  <h3>Changes to {side} state</h3>
                  {preview[`${side}Changes`].length ? (
                    <ul className="sync-changes">
                      {preview[`${side}Changes`].map((change) => (
                        <li key={`${change.collection}/${change.id}`}>
                          <strong className={`sync-state sync-change-${change.kind}`}>
                            {change.kind}
                          </strong>{' '}
                          {change.collection}
                          {change.title && <>: {change.title}</>} <code>{change.id}</code>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>No changes.</p>
                  )}
                </section>
              ))}
              {preview.mode === 'merge' && !!preview.conflicts.length && (
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
              {preview.mode === 'merge' && (
                <p>
                  Selected conflict resolution: <strong>{preview.resolution ?? 'None'}</strong>
                </p>
              )}
              {preview.validationError && (
                <div className="callout warning" role="alert">
                  {preview.validationError}
                </div>
              )}
              {preview.canApply && !hasChanges && (
                <p className="callout sync-state-clean" role="status">
                  Already up to date. No changes to apply.
                </p>
              )}
              {preview.canApply && hasChanges && (
                <label className="sync-confirm">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={busy}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                  {preview.mode === 'revert'
                    ? 'I confirm discarding unsynced local changes and replacing this workspace from origin.'
                    : 'I confirm applying these changes to local and remote state.'}
                </label>
              )}
            </>
          )}
          {busy && <p role="status">Working on workspace sync...</p>}
          <footer>
            {mode === null ? (
              <>
                <button className="button" disabled={busy} onClick={() => void request('status')}>
                  Refresh status
                </button>
                <button
                  className="button sync-push"
                  disabled={
                    busy || workspace.type === 'local' || !status?.configured || status.syncing
                  }
                  onClick={() => void request('preview')}
                >
                  Push to origin
                </button>
                <button
                  className="button sync-reset"
                  disabled={
                    busy || workspace.type === 'local' || !status?.configured || status.syncing
                  }
                  onClick={() => void request('preview', undefined, 'revert')}
                >
                  Reset to origin
                </button>
              </>
            ) : (
              <>
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => {
                    setMode(null);
                    setPreview(null);
                    setConfirmed(false);
                    setError('');
                    setSuccess(false);
                  }}
                >
                  Back to sync options
                </button>
                <button
                  className="button"
                  disabled={busy || !status?.configured || status.syncing}
                  onClick={() => void request('preview', undefined, mode)}
                >
                  Refresh preview
                </button>
              </>
            )}
            {preview && hasChanges && (
              <button
                className={`button ${mode === 'revert' ? 'sync-reset' : 'sync-push'}`}
                disabled={busy || !preview.canApply || !confirmed}
                onClick={() => void request('apply')}
              >
                {preview.mode === 'revert' ? 'Confirm reset to origin' : 'Apply sync'}
              </button>
            )}
          </footer>
        </div>
      </Dialog>
    </DialogErrorContext>
  );
}
