import { useEffect, useRef, useState } from 'react';
import { safeSyncRef, type WorkspaceBranches, type WorkspaceFiles } from '../shared';
import type {
  CreateWorkspaceInput,
  Workspace,
  WorkspaceList,
  WorkspaceRepositories,
  WorkspaceRemovalPreview,
} from '../shared';
import { api } from './api';
import { WorkspaceApp } from './App';
import { Dialog, DialogErrorContext } from './Dialogs';
import { LoadingField } from './LoadingField';

const selectedWorkspace = () => new URL(window.location.href).searchParams.get('workspace');

export function App() {
  const [list, setList] = useState<WorkspaceList | null>(null);
  const [selected, setSelected] = useState(selectedWorkspace);
  const [error, setError] = useState('');
  const [editor, setEditor] = useState<
    'add' | 'add-cloud' | 'rename' | 'connect' | 'remove' | null
  >(null);
  const [revision, setRevision] = useState(0);
  const [syncIntent, setSyncIntent] = useState<string | null>(null);
  const discoveryId = useRef(0);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      const id = ++discoveryId.current;
      void api<WorkspaceList>('/workspaces').then(
        (value) => {
          if (!active || id !== discoveryId.current) return;
          setList(value);
          setSelected((current) => current ?? value.defaultWorkspaceId);
          setError('');
        },
        (error: unknown) => {
          if (active && id === discoveryId.current)
            setError(error instanceof Error ? error.message : 'Cannot load workspaces.');
        },
      );
    };
    refresh();
    window.addEventListener('focus', refresh);
    const timer = window.setInterval(refresh, 15_000);
    return () => {
      active = false;
      window.removeEventListener('focus', refresh);
      window.clearInterval(timer);
    };
  }, [revision]);

  useEffect(() => {
    const onPop = () => {
      setSelected(selectedWorkspace());
      setEditor(null);
      setSyncIntent(null);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  function select(id: string | null) {
    const url = new URL(window.location.href);
    if (
      id === null ||
      (id !== (selected ?? list?.defaultWorkspaceId) && url.hash.startsWith('#/tasks/'))
    )
      url.hash = '/';
    if (id === null) url.searchParams.delete('workspace');
    else url.searchParams.set('workspace', id);
    window.history.pushState(null, '', url);
    setSelected(id);
    setEditor(null);
    setSyncIntent(null);
  }

  const workspace = list?.workspaces.find(
    (entry) => entry.id === (selected ?? list.defaultWorkspaceId),
  );
  const adding = editor === 'add' || editor === 'add-cloud';
  const workspaceEditor = list && editor && editor !== 'remove' && (adding || workspace) && (
    <WorkspaceEditor
      key={`${workspace?.id ?? 'empty'}/${editor}`}
      {...(adding
        ? {
            mode: 'add' as const,
            initialType: editor === 'add-cloud' ? ('cloud' as const) : ('local' as const),
          }
        : { mode: editor as 'rename' | 'connect', workspace: workspace! })}
      close={() => setEditor(null)}
      saved={(entry) => {
        discoveryId.current++;
        setList((previous) => ({
          ...(previous ?? list),
          defaultWorkspaceId: (previous ?? list).defaultWorkspaceId ?? entry.id,
          workspaces: adding
            ? [...(previous ?? list).workspaces.filter((old) => old.id !== entry.id), entry]
            : (previous ?? list).workspaces.map((old) => (old.id === entry.id ? entry : old)),
        }));
        setError('');
        select(entry.id);
        if (editor !== 'rename' && entry.type === 'cloud') setSyncIntent(entry.id);
      }}
    />
  );
  if (list && list.workspaces.length === 0)
    return (
      <>
        <main className="workspace-empty">
          <div className="brand">FoggyBrain</div>
          <section aria-labelledby="workspace-empty-title">
            <div className="eyebrow">YOUR WORKSPACE, YOUR DEVICE</div>
            <h1 id="workspace-empty-title">Add or connect workspace</h1>
            <p>
              No workspaces are saved on this device. Start a fresh task graph, or reconnect to a
              cloud workspace.
            </p>
            <div className="workspace-empty-options">
              <div>
                <h2>A fresh place to think</h2>
                <p>Keep your tasks on this device. You can connect to cloud later.</p>
                <button className="button primary" onClick={() => setEditor('add')}>
                  Add workspace
                </button>
              </div>
              <div>
                <h2>Bring your workspace along</h2>
                <p>
                  Choose an existing private repository, branch, and state file. Review a sync
                  preview before importing anything.
                </p>
                <button className="button" onClick={() => setEditor('add-cloud')}>
                  Connect to cloud
                </button>
              </div>
            </div>
            {error && <p role="alert">Cannot refresh workspaces: {error}</p>}
          </section>
        </main>
        {workspaceEditor}
      </>
    );
  if (!list || !workspace)
    return (
      <main className="empty-state">
        <h1>FoggyBrain</h1>
        {error || list ? (
          <p role="alert">
            {error || 'This workspace is not available. Choose a saved workspace.'}
          </p>
        ) : (
          <p role="status">Loading workspaces...</p>
        )}
        <button className="button" onClick={() => setRevision((value) => value + 1)}>
          Retry
        </button>
        {list?.workspaces.map((entry) => (
          <button className="button" key={entry.id} onClick={() => select(entry.id)}>
            {entry.name}
          </button>
        ))}
      </main>
    );

  return (
    <>
      <WorkspaceApp
        key={workspace.id}
        workspace={workspace}
        initialSyncPreview={syncIntent === workspace.id}
        consumeSyncPreview={() => setSyncIntent(null)}
        settings={
          <section className="page-content workspace-settings" aria-labelledby="settings-title">
            <div className="page-heading">
              <div>
                <div className="eyebrow">YOUR WORKSPACE, YOUR DEVICE</div>
                <h1 id="settings-title">Workspace settings</h1>
                <p>Manage the selected workspace and its storage configuration.</p>
              </div>
            </div>
            <dl className="workspace-metadata" aria-label="Workspace metadata">
              <div>
                <dt>Name</dt>
                <dd>{workspace.name}</dd>
              </div>
              <div>
                <dt>Storage type</dt>
                <dd>{workspace.type === 'cloud' ? 'Cloud' : 'Local'}</dd>
              </div>
              <div>
                <dt>Repository</dt>
                <dd>{workspace.target?.repo ?? 'Not connected'}</dd>
              </div>
              <div>
                <dt>Branch</dt>
                <dd>{workspace.target?.branch ?? 'Not configured'}</dd>
              </div>
              <div>
                <dt>State file path</dt>
                <dd>{workspace.target?.path ?? 'Not configured'}</dd>
              </div>
              <div>
                <dt>Server credential</dt>
                <dd>
                  {workspace.credential === 'dedicated'
                    ? 'Dedicated sync token (FOGGY_SYNC_TOKEN)'
                    : workspace.credential === 'github'
                      ? 'GitHub credential (explicit opt-in)'
                      : 'Not configured'}
                </dd>
              </div>
            </dl>
            <p className="form-hint">
              {workspace.type === 'cloud'
                ? 'Cloud workspaces keep tasks on this device. Use Workspace sync to review and explicitly apply changes. Cloud targets cannot be changed or converted back to local.'
                : 'Tasks are stored on this device. Connecting to cloud preserves local tasks and opens a sync preview. Nothing is imported or published until you review and explicitly confirm apply.'}
            </p>
            <div className="workspace-actions">
              <button className="button" onClick={() => setEditor('rename')}>
                Rename workspace
              </button>
              {workspace.type === 'local' && (
                <button className="button" onClick={() => setEditor('connect')}>
                  Connect to cloud
                </button>
              )}
              <button
                className="button primary"
                disabled={list.workspaces.length >= Math.min(3, list.limit)}
                onClick={() => setEditor('add')}
              >
                Add workspace
              </button>
            </div>
            <p className="form-hint">
              {list.workspaces.length} / {Math.min(3, list.limit)} saved workspaces. Each workspace
              has an independent task graph.
            </p>
            <section className="workspace-danger" aria-labelledby="workspace-danger-title">
              <h2 id="workspace-danger-title">Remove from this device</h2>
              <p>
                Remove this workspace and its local data permanently. Cloud repositories are
                untouched.
              </p>
              <button className="button danger" onClick={() => setEditor('remove')}>
                Remove workspace
              </button>
            </section>
          </section>
        }
        controls={
          <div className="workspace-controls">
            <label>
              Workspace
              <select
                aria-label="Workspace"
                value={workspace.id}
                onChange={(event) => select(event.target.value)}
              >
                {list.workspaces.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name} ({entry.type === 'local' ? 'Local' : 'Cloud'})
                  </option>
                ))}
              </select>
            </label>
            <div className="workspace-actions">
              <button className="text-button" onClick={() => setEditor('rename')}>
                Rename
              </button>
              <button
                className="text-button"
                disabled={list.workspaces.length >= Math.min(3, list.limit)}
                onClick={() => setEditor('add')}
              >
                Add workspace
              </button>
            </div>
            {workspace.type === 'local' && (
              <button className="text-button" onClick={() => setEditor('connect')}>
                Connect to cloud
              </button>
            )}
            <small>
              {list.workspaces.length} / {Math.min(3, list.limit)} saved workspaces
            </small>
            {error && (
              <p className="form-hint" role="alert">
                Cannot refresh workspaces: {error} Showing last loaded metadata.
              </p>
            )}
          </div>
        }
      />
      {editor === 'remove' && (
        <WorkspaceRemoval
          key={`remove/${workspace.id}`}
          workspace={workspace}
          close={() => setEditor(null)}
          refresh={() => setRevision((value) => value + 1)}
          updated={(value, removed) => {
            discoveryId.current++;
            setList(value);
            setError('');
            if (removed) select(value.defaultWorkspaceId);
          }}
        />
      )}
      {workspaceEditor}
    </>
  );
}

function WorkspaceRemoval({
  workspace,
  close,
  updated,
  refresh,
}: {
  workspace: Workspace;
  close: () => void;
  updated: (list: WorkspaceList, removed: boolean) => void;
  refresh: () => void;
}) {
  const [preview, setPreview] = useState<WorkspaceRemovalPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const active = useRef(true);
  const pending = useRef(false);
  const path = `/workspaces/${encodeURIComponent(workspace.id)}`;
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    let current = true;
    setPreview(null);
    setConfirmed(false);
    setError('');
    setBusy(true);
    void api<WorkspaceRemovalPreview>(`${path}/removal-preview`)
      .then(
        (value) => {
          if (current) {
            if (value.workspace.id !== workspace.id)
              setError('Preview workspace does not match. Review again.');
            else setPreview(value);
          }
        },
        (error: unknown) => {
          if (current) setError(error instanceof Error ? error.message : 'Cannot preview removal.');
        },
      )
      .finally(() => {
        if (current) setBusy(false);
      });
    return () => {
      current = false;
    };
  }, [path, workspace.id, attempt]);
  function cancel() {
    if (!pending.current) close();
  }
  return (
    <DialogErrorContext value={error}>
      <Dialog title="Remove workspace from this device?" danger close={cancel}>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (pending.current || busy || !preview?.canRemove || !confirmed) return;
            pending.current = true;
            setBusy(true);
            setError('');
            const revision = preview.revision;
            setPreview(null);
            setConfirmed(false);
            try {
              const result = await api<WorkspaceList>(`${path}?confirm=true`, 'DELETE', {
                revision,
              });
              if (active.current) updated(result, true);
              else refresh();
            } catch (error) {
              if (active.current)
                setError(
                  `${error instanceof Error ? error.message : 'Removal failed.'} The outcome may be uncertain. Review a new preview before trying again.`,
                );
              try {
                const result = await api<WorkspaceList>('/workspaces');
                if (active.current) updated(result, false);
                else refresh();
              } catch {
                if (active.current)
                  setError(
                    (value) =>
                      `${value} Cannot refresh workspaces; refresh the list before proceeding.`,
                  );
                refresh();
              }
            } finally {
              pending.current = false;
              if (active.current) setBusy(false);
            }
          }}
        >
          <p className="workspace-removal-target">
            <strong>{preview?.workspace.name ?? workspace.name}</strong> ({workspace.id})
          </p>
          <p>
            All local tasks, relationships, layouts, sync history, backups, and unsynced changes
            will be lost. There is no undo.
          </p>
          <p>
            The cloud repository, branch, and state file are untouched. Nothing is deleted or
            published remotely.
          </p>
          {(preview?.workspace.target ?? workspace.target) && (
            <p className="workspace-removal-target">
              Repository: {(preview?.workspace.target ?? workspace.target)!.repo}
              <br />
              Branch: {(preview?.workspace.target ?? workspace.target)!.branch}
              <br />
              State file: {(preview?.workspace.target ?? workspace.target)!.path}
            </p>
          )}
          {busy && (
            <p role="status">
              {pending.current ? 'Removing workspace...' : 'Loading removal preview...'}
            </p>
          )}
          {preview && (
            <>
              <p>
                {preview.taskCount} tasks, {preview.dependencyCount} dependencies,{' '}
                {preview.referenceCount} references will be removed.
              </p>
              {preview.dirty && (
                <p className="callout warning">Unsynced local changes will be permanently lost.</p>
              )}
              {!preview.canRemove && (
                <p role="alert">{preview.reason ?? 'This workspace cannot be removed.'}</p>
              )}
            </>
          )}
          <label className="workspace-removal-confirm">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy || !preview?.canRemove}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            I understand that this permanently removes this workspace's local data with no undo.
          </label>
          <footer>
            <button type="button" className="button" disabled={pending.current} onClick={cancel}>
              Cancel
            </button>
            {!preview && !busy && (
              <button
                type="button"
                className="button"
                onClick={() => setAttempt((value) => value + 1)}
              >
                Review new preview
              </button>
            )}
            <button className="button danger" disabled={busy || !preview?.canRemove || !confirmed}>
              Remove permanently
            </button>
          </footer>
        </form>
      </Dialog>
    </DialogErrorContext>
  );
}

function WorkspaceEditor({
  mode,
  workspace,
  initialType = 'local',
  close,
  saved,
}: {
  close: () => void;
  saved: (workspace: Workspace) => void;
} & (
  | { mode: 'add'; workspace?: never; initialType?: 'local' | 'cloud' }
  | { mode: 'rename' | 'connect'; workspace: Workspace; initialType?: never }
)) {
  const [name, setName] = useState(mode === 'add' ? '' : workspace.name);
  const [type, setType] = useState<'local' | 'cloud'>(mode === 'connect' ? 'cloud' : initialType);
  const [repo, updateRepo] = useState('');
  const [branch, updateBranch] = useState('');
  const [path, setPath] = useState('');
  function setBranch(value: string) {
    if (value === branch) return;
    updateBranch(value);
    setPath('');
  }
  function setRepo(value: string) {
    if (value === repo) return;
    updateRepo(value);
    setBranch('');
  }
  const [credential, setCredential] = useState<'dedicated' | 'github'>('dedicated');
  const [discovery, setDiscovery] = useState<WorkspaceRepositories | null>(null);
  const [repositoryError, setRepositoryError] = useState('');
  const [search, setSearch] = useState('');
  const [repositoryOpen, setRepositoryOpen] = useState(false);
  const [activeRepository, setActiveRepository] = useState(-1);
  const repositoryList = useRef<HTMLUListElement>(null);
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const active = useRef(true);
  const pending = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const cloud = mode !== 'rename' && type === 'cloud';
  useEffect(() => {
    let active = true;
    setRepo('');
    setSearch('');
    setRepositoryOpen(false);
    setActiveRepository(-1);
    setDiscovery(null);
    setRepositoryError('');
    if (cloud) {
      void api<WorkspaceRepositories>(`/workspaces/repositories?credential=${credential}`).then(
        (result) => {
          if (active) setDiscovery(result);
        },
        (error: unknown) => {
          if (active)
            setRepositoryError(
              error instanceof Error ? error.message : 'Cannot load repositories.',
            );
        },
      );
    }
    return () => {
      active = false;
    };
  }, [cloud, credential, retry]);
  const visibleRepositories =
    discovery?.repositories.filter((entry) =>
      entry.fullName.toLowerCase().includes(search.trim().toLowerCase()),
    ) ?? [];
  const repositoryExpanded = repositoryOpen && !!discovery && !busy;
  const repositoryLoading = cloud && !discovery && !repositoryError;
  const highlightedRepository = repositoryExpanded
    ? visibleRepositories[activeRepository]
    : undefined;
  const validRepository = discovery?.repositories.some((entry) => entry.fullName === repo);
  useEffect(() => {
    if (highlightedRepository)
      repositoryList.current
        ?.querySelector('[data-active="true"]')
        ?.scrollIntoView({ block: 'nearest' });
  }, [highlightedRepository]);
  function chooseRepository(entry: WorkspaceRepositories['repositories'][number]) {
    setRepo(entry.fullName);
    setSearch(entry.fullName);
    setRepositoryOpen(false);
    setActiveRepository(-1);
  }
  const title =
    mode === 'add' ? 'Add workspace' : mode === 'rename' ? 'Rename workspace' : 'Connect to cloud';
  return (
    <DialogErrorContext value={error}>
      <Dialog
        title={title}
        close={() => {
          if (!pending.current) close();
        }}
      >
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (pending.current || (cloud && (!validRepository || !branch || !safeSyncRef(path))))
              return;
            pending.current = true;
            setBusy(true);
            setError('');
            try {
              const input: CreateWorkspaceInput = {
                name: name.trim(),
                type,
                ...(cloud
                  ? {
                      target: { repo: repo.trim(), branch: branch.trim(), path: path.trim() },
                      credential,
                    }
                  : {}),
              };
              const result = await api<Workspace>(
                mode === 'add' ? '/workspaces' : `/workspaces/${encodeURIComponent(workspace.id)}`,
                mode === 'add' ? 'POST' : 'PATCH',
                mode === 'rename' ? { name: name.trim() } : input,
              );
              if (active.current) saved(result);
            } catch (error) {
              if (active.current)
                setError(error instanceof Error ? error.message : 'Cannot save workspace.');
            } finally {
              pending.current = false;
              if (active.current) setBusy(false);
            }
          }}
        >
          <label>
            Name
            <input
              required
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {mode === 'add' && (
            <label>
              Storage type
              <select
                value={type}
                onChange={(event) => setType(event.target.value as 'local' | 'cloud')}
              >
                <option value="local">Local</option>
                <option value="cloud">Cloud</option>
              </select>
            </label>
          )}
          {cloud ? (
            <>
              <label>
                Server credential
                <select
                  disabled={busy}
                  value={credential}
                  onChange={(event) => {
                    setRepo('');
                    setDiscovery(null);
                    setCredential(event.target.value as 'dedicated' | 'github');
                  }}
                >
                  <option value="dedicated">Dedicated sync token (recommended)</option>
                  <option value="github">Reuse GitHub credential (explicit opt-in)</option>
                </select>
              </label>
              <p className="form-hint">
                Lists private repositories owned by the account authenticated with the selected
                server credential, not your browser session or necessarily the PR polling account.
                Organization and collaborator repositories are not listed.
              </p>
              {repositoryLoading && (
                <p id="repository-loading" role="status">
                  Loading repositories...
                </p>
              )}
              {repositoryError && (
                <div>
                  <p role="alert">{repositoryError}</p>
                  <button
                    type="button"
                    className="button"
                    onClick={() => setRetry((value) => value + 1)}
                  >
                    Retry repositories
                  </button>
                </div>
              )}
              {discovery && <p className="form-hint">Authenticated as {discovery.login}.</p>}
              <div className="repository-picker">
                <label htmlFor="workspace-repository">Repository</label>
                <LoadingField loading={repositoryLoading}>
                  <input
                    id="workspace-repository"
                    role="combobox"
                    aria-autocomplete="list"
                    aria-busy={repositoryLoading}
                    aria-describedby={repositoryLoading ? 'repository-loading' : undefined}
                    aria-expanded={repositoryExpanded}
                    aria-controls="workspace-repositories"
                    aria-activedescendant={
                      highlightedRepository
                        ? `workspace-repository-${highlightedRepository.id}`
                        : undefined
                    }
                    autoComplete="off"
                    placeholder={
                      repositoryLoading ? 'Loading repositories...' : 'Search private repositories'
                    }
                    required
                    value={search}
                    disabled={busy || !discovery}
                    onFocus={() => setRepositoryOpen(true)}
                    onClick={() => setRepositoryOpen(true)}
                    onBlur={() => {
                      setRepositoryOpen(false);
                      setActiveRepository(-1);
                    }}
                    onChange={(event) => {
                      setSearch(event.target.value);
                      setRepo('');
                      setRepositoryOpen(true);
                      setActiveRepository(-1);
                    }}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing) return;
                      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                        event.preventDefault();
                        setRepositoryOpen(true);
                        const count = visibleRepositories.length;
                        setActiveRepository(
                          count
                            ? !repositoryExpanded || activeRepository < 0
                              ? event.key === 'ArrowDown'
                                ? 0
                                : count - 1
                              : (activeRepository + (event.key === 'ArrowDown' ? 1 : -1) + count) %
                                count
                            : -1,
                        );
                      } else if (event.key === 'Enter' && repositoryExpanded) {
                        event.preventDefault();
                        if (highlightedRepository) chooseRepository(highlightedRepository);
                      } else if (event.key === 'Escape' && repositoryExpanded) {
                        event.preventDefault();
                        event.stopPropagation();
                        setRepositoryOpen(false);
                        setActiveRepository(-1);
                      }
                    }}
                  />
                </LoadingField>
                <ul
                  id="workspace-repositories"
                  ref={repositoryList}
                  role="listbox"
                  aria-label="Repositories"
                  hidden={!repositoryExpanded}
                >
                  {visibleRepositories.map((entry, index) => (
                    <li
                      key={entry.id}
                      id={`workspace-repository-${entry.id}`}
                      role="option"
                      aria-selected={repo === entry.fullName}
                      data-active={activeRepository === index}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => chooseRepository(entry)}
                    >
                      {entry.fullName}
                    </li>
                  ))}
                </ul>
              </div>
              {discovery && !visibleRepositories.length && (
                <p role="status">
                  {discovery.repositories.length
                    ? 'No repositories match your search.'
                    : 'No owned private repositories are visible to this credential. Check token repository access or choose another server credential.'}
                </p>
              )}
              <DiscoveryPicker
                key={`branch/${credential}/${repo}`}
                kind="branches"
                query={repo ? new URLSearchParams({ credential, repo }).toString() : ''}
                disabled={busy || !validRepository}
                value={branch}
                choose={setBranch}
              />
              <DiscoveryPicker
                key={`path/${credential}/${repo}/${branch}`}
                kind="files"
                query={branch ? new URLSearchParams({ credential, repo, branch }).toString() : ''}
                disabled={busy || !validRepository || !branch}
                value={path}
                choose={setPath}
              />
              <p className="form-hint">
                {credential === 'dedicated'
                  ? 'Uses FOGGY_SYNC_TOKEN on the server. No fallback to the GitHub credential.'
                  : 'Reuses server GH_TOKEN / GITHUB_TOKEN / gh auth token. This credential also needs Contents read/write access, not just PR read access.'}{' '}
                Restrict Contents read/write access to the selected private repository. The branch
                must already exist. Never enter a token here.
              </p>
              <p className="form-hint">
                Saving opens a sync preview, not an automatic apply. Review the changes and
                explicitly confirm apply to import or publish tasks. Existing local tasks are
                preserved. Cloud targets cannot be changed or converted back to local.
              </p>
            </>
          ) : (
            mode === 'add' && (
              <p className="form-hint">
                A separate local workspace stored on this device. You can connect it to cloud later.
              </p>
            )
          )}
          <footer>
            <button type="button" className="button" disabled={busy} onClick={close}>
              Cancel
            </button>
            <button
              className="button primary"
              disabled={
                busy ||
                !name.trim() ||
                (cloud && (!validRepository || !branch || !safeSyncRef(path)))
              }
            >
              {busy ? 'Saving...' : 'Save workspace'}
            </button>
          </footer>
        </form>
      </Dialog>
    </DialogErrorContext>
  );
}

function DiscoveryPicker({
  kind,
  query,
  disabled,
  value,
  choose,
}: {
  kind: 'branches' | 'files';
  query: string;
  disabled: boolean;
  value: string;
  choose: (value: string) => void;
}) {
  const [items, setItems] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const list = useRef<HTMLUListElement>(null);
  const files = kind === 'files';
  const id = `workspace-${kind}`;
  useEffect(() => {
    if (!query) return;
    let current = true;
    setItems(null);
    setError('');
    void api<WorkspaceBranches | WorkspaceFiles>(`/workspaces/${kind}?${query}`).then(
      (result) => {
        if (current) setItems('paths' in result ? result.paths : result.branches);
      },
      (error: unknown) => {
        if (current) setError(error instanceof Error ? error.message : 'Discovery failed.');
      },
    );
    return () => {
      current = false;
    };
  }, [kind, query, retry]);
  const visible = (items ?? []).filter((item) =>
    item.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const newPath = files && safeSyncRef(search.trim()) && !items?.includes(search.trim());
  const options = [...visible, ...(newPath ? [search.trim()] : [])];
  const expanded = open && !!items && !disabled;
  const loading = !!query && !items && !error;
  const highlighted = expanded && active >= 0 && active < options.length;
  useEffect(() => {
    if (highlighted)
      list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, highlighted]);
  function select(entry: string) {
    choose(entry);
    setSearch(entry);
    setOpen(false);
    setActive(-1);
  }
  return (
    <>
      <div className="repository-picker">
        <label htmlFor={id}>{files ? 'State file path' : 'Branch'}</label>
        <LoadingField loading={loading}>
          <input
            id={id}
            role="combobox"
            aria-autocomplete="list"
            aria-busy={loading}
            aria-expanded={expanded}
            aria-controls={`${id}-list`}
            aria-describedby={loading ? `${id}-hint ${id}-loading` : `${id}-hint`}
            aria-activedescendant={highlighted ? `${id}-${active}` : undefined}
            autoComplete="off"
            required
            value={search}
            disabled={disabled || !items}
            placeholder={
              loading
                ? `Loading ${kind}...`
                : files
                  ? 'Search JSON files or enter a new path'
                  : 'Search existing branches'
            }
            onFocus={() => setOpen(true)}
            onClick={() => setOpen(true)}
            onBlur={() => {
              setOpen(false);
              setActive(-1);
            }}
            onChange={(event) => {
              setSearch(event.target.value);
              choose('');
              setOpen(true);
              setActive(-1);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                setOpen(true);
                setActive(
                  options.length
                    ? !expanded || active < 0
                      ? event.key === 'ArrowDown'
                        ? 0
                        : options.length - 1
                      : (active + (event.key === 'ArrowDown' ? 1 : -1) + options.length) %
                        options.length
                    : -1,
                );
              } else if (event.key === 'Enter') {
                event.preventDefault();
                if (highlighted) select(options[active]);
              } else if (event.key === 'Escape' && expanded) {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
                setActive(-1);
              }
            }}
          />
        </LoadingField>
        <ul
          id={`${id}-list`}
          ref={list}
          role="listbox"
          aria-label={files ? 'State paths' : 'Branches'}
          hidden={!expanded}
        >
          {options.map((entry, index) => (
            <li
              key={entry}
              id={`${id}-${index}`}
              role="option"
              aria-selected={value === entry}
              data-active={active === index}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => select(entry)}
            >
              {newPath && index === visible.length ? `Use new path: ${entry}` : entry}
            </li>
          ))}
        </ul>
      </div>
      <p className="form-hint" id={`${id}-hint`}>
        {!query
          ? files
            ? 'Select a branch to unlock the state path.'
            : 'Select a repository to unlock branches.'
          : files
            ? 'JSON candidates only; contents and path availability are not verified until sync preview. Enter a safe new path to publish local state.'
            : 'Select an existing branch explicitly. Only branches supported by sync path validation are listed.'}
      </p>
      {loading && (
        <p id={`${id}-loading`} role="status">
          Loading {kind}...
        </p>
      )}
      {query && error && (
        <div>
          <p role="alert">{error}</p>
          <button
            type="button"
            className="button"
            disabled={disabled}
            onClick={() => setRetry((value) => value + 1)}
          >
            Retry {kind}
          </button>
        </div>
      )}
      {items && !options.length && (
        <p role="status">
          {files
            ? 'No matching JSON files. Enter a safe new state path.'
            : 'No matching supported branches.'}
        </p>
      )}
    </>
  );
}
