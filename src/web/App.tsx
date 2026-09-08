import { startTransition, useEffect, useRef, useState } from 'react';
import {
  ArrowDownRight,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Box,
  Check,
  ChevronRight,
  CircleHelp,
  CloudFog,
  GitPullRequest,
  LayoutGrid,
  Link2,
  ListChecks,
  LoaderCircle,
  Menu,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import type {
  CreateTaskInput,
  DeletionPreview,
  GithubPr,
  GithubStatus,
  Layout,
  Snapshot,
  TaskView,
  UpdateTaskInput,
} from '../shared';
import { api } from './api';
import { Graph } from './Graph';
import { Detail } from './Detail';
import { DeleteDialog, Dialog, DialogErrorContext, ReferenceDialog, TaskDialog } from './Dialogs';
import { Status, statusLabels } from './Status';

type Modal =
  | { type: 'create'; parentId?: string | null; prUrl?: string }
  | { type: 'edit'; task: TaskView }
  | { type: 'reference'; containerId: string }
  | { type: 'delete'; task: TaskView; preview: DeletionPreview }
  | { type: 'help' }
  | null;
const empty: Snapshot = { tasks: [], dependencies: [], references: [], layouts: [] };
const route = () => window.location.hash.slice(1) || '/';

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>(empty);
  const [github, setGithub] = useState<GithubStatus | null>(null);
  const [prs, setPrs] = useState<GithubPr[]>([]);
  const [path, setPath] = useState(route);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [edgeId, setEdgeId] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [sidebar, setSidebar] = useState(false);
  const refreshId = useRef(0);
  const mutation = useRef(false);

  async function refresh() {
    const id = ++refreshId.current;
    try {
      const [state, status, pulls] = await Promise.all([
        api<Snapshot>('/state'),
        api<GithubStatus>('/github/status'),
        api<GithubPr[]>('/github/prs'),
      ]);
      if (id !== refreshId.current) return;
      startTransition(() => {
        setSnapshot((previous) =>
          JSON.stringify(previous) === JSON.stringify(state) ? previous : state,
        );
        setGithub(status);
        setPrs(pulls);
        setConnectionError('');
        setLoading(false);
      });
    } catch {
      if (id === refreshId.current) {
        setConnectionError(
          'Cannot reach the local server. Keep pnpm dev or pnpm start running; your last loaded graph is shown.',
        );
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (!mutation.current) void refresh();
    }, 4000);
    const onHash = () => {
      setPath(route());
      setEdgeId(null);
      setSidebar(false);
    };
    window.addEventListener('hashchange', onHash);
    return () => {
      clearInterval(timer);
      window.removeEventListener('hashchange', onHash);
      refreshId.current++;
    };
  }, []);

  async function run(operation: () => Promise<unknown>): Promise<boolean> {
    if (mutation.current) return false;
    mutation.current = true;
    refreshId.current++;
    setBusy(true);
    setError('');
    try {
      await operation();
      await refresh();
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Something went wrong.');
      return false;
    } finally {
      mutation.current = false;
      setBusy(false);
    }
  }

  const navigate = (next: string) => {
    window.location.hash = next;
    setPath(next);
    setSelectedId(null);
    setEdgeId(null);
    setSidebar(false);
  };
  const open = (id: string) => {
    const task = snapshot.tasks.find((task) => task.id === id);
    if (!task) return;
    if (task.kind === 'container') {
      navigate(`/tasks/${id}`);
      setSelectedId(null);
    } else {
      navigate(task.parentId ? `/tasks/${task.parentId}` : '/map');
      setSelectedId(id);
    }
  };
  const currentId = path.startsWith('/tasks/') ? path.slice('/tasks/'.length) : null;
  const current = snapshot.tasks.find((task) => task.id === currentId);
  const isGraph = path === '/map' || !!currentId;
  const isPrs = path === '/prs';
  const viewId = currentId ?? 'root';
  const selected = snapshot.tasks.find(
    (task) =>
      task.id === selectedId &&
      (viewId === 'root' ? task.parentId === null : current?.childrenIds.includes(task.id)),
  );
  const edge = snapshot.dependencies.find((edge) => edge.id === edgeId);
  const roots = snapshot.tasks.filter((task) => task.parentId === null);
  const containers = roots.filter((task) => task.kind === 'container');
  const viewTasks = snapshot.tasks.filter((task) =>
    viewId === 'root' ? task.parentId === null : current?.childrenIds.includes(task.id),
  );
  const leaves = snapshot.tasks.filter((task) => task.kind !== 'container');
  const available = leaves.filter((task) => task.status === 'available').length;
  const ready = leaves.filter((task) => task.status === 'ready').length;
  const complete = leaves.filter((task) => task.status === 'completed').length;
  const layout = snapshot.layouts.find((layout) => layout.viewId === viewId);
  const filtered = roots.filter(
    (task) =>
      task.title.toLowerCase().includes(query.toLowerCase()) ||
      task.description.toLowerCase().includes(query.toLowerCase()),
  );

  async function saveTask(input: CreateTaskInput | UpdateTaskInput, id?: string) {
    let created: TaskView | undefined;
    const success = await run(async () => {
      created = await api<TaskView>(id ? `/tasks/${id}` : '/tasks', id ? 'PATCH' : 'POST', input);
    });
    if (success && created && !id) {
      if (created.parentId) {
        navigate(`/tasks/${created.parentId}`);
        setSelectedId(created.id);
      } else if (created.kind === 'container') navigate(`/tasks/${created.id}`);
      else {
        navigate('/map');
        setSelectedId(created.id);
      }
    }
    return success;
  }

  async function previewDelete(task: TaskView) {
    await run(async () => {
      const preview = await api<DeletionPreview>(`/tasks/${task.id}/deletion-preview`);
      setModal({ type: 'delete', task, preview });
    });
  }

  const addDependency = (prerequisiteId: string, dependentId: string) => {
    void run(() => api('/dependencies', 'POST', { prerequisiteId, dependentId }));
  };
  const saveLayout = (layout: Layout) => {
    void run(() => api('/layout', 'PUT', layout));
  };

  const breadcrumbs: TaskView[] = [];
  let ancestor = current;
  while (ancestor) {
    breadcrumbs.unshift(ancestor);
    ancestor = snapshot.tasks.find((task) => task.id === ancestor!.parentId);
  }

  return (
    <div className="app-shell">
      {sidebar && (
        <button
          className="sidebar-scrim"
          aria-label="Close navigation"
          onClick={() => setSidebar(false)}
        />
      )}
      <aside className={`sidebar ${sidebar ? 'sidebar-open' : ''}`}>
        <button className="brand" onClick={() => navigate('/')}>
          <span className="brand-mark">
            <CloudFog size={25} />
          </span>
          <span>
            FoggyBrain<small>A LITTLE CLARITY.</small>
          </span>
        </button>
        <div className="workspace-label">
          <span className="workspace-avatar">F</span>
          <span>
            Personal workspace<small>Just you. All your moving parts.</small>
          </span>
          <span className="local-dot" title="Local workspace" />
        </div>
        <div className="nav-label">YOUR SPACE</div>
        <nav aria-label="Main navigation">
          <button className={path === '/' ? 'active' : ''} onClick={() => navigate('/')}>
            <LayoutGrid size={17} />
            Overview<span className="nav-count">{roots.length}</span>
          </button>
          <button className={isGraph ? 'active' : ''} onClick={() => navigate('/map')}>
            <Network size={17} />
            Workspace map
          </button>
          <button className={isPrs ? 'active' : ''} onClick={() => navigate('/prs')}>
            <GitPullRequest size={17} />
            Pull requests<span className="nav-count">{prs.length}</span>
          </button>
        </nav>
        <div className="nav-label task-nav-label">
          TASK CONTAINERS
          <button
            className="icon-button"
            onClick={() => setModal({ type: 'create' })}
            aria-label="New container"
          >
            <Plus size={15} />
          </button>
        </div>
        <div className="container-nav">
          {containers.length ? (
            containers.map((task) => (
              <button
                key={task.id}
                className={currentId === task.id ? 'selected' : ''}
                onClick={() => open(task.id)}
              >
                <span className={`tiny-status tiny-${task.status}`} />
                <span>{task.title}</span>
                {task.status === 'completed' && <Check size={13} />}
              </button>
            ))
          ) : (
            <p>Your next idea goes here.</p>
          )}
        </div>
        <div className="sidebar-bottom">
          <div className="quiet-note">
            <Network size={22} />
            <p>
              You don't have to hold
              <br />
              it all in your head.
            </p>
          </div>
          <button onClick={() => setModal({ type: 'help' })}>
            <Terminal size={16} />
            CLI & quick guide
            <ArrowUpRight size={14} />
          </button>
          <div className="local-footer">
            <span className="local-dot" />
            LOCAL-FIRST<span>v0.1</span>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="icon-button mobile-menu"
              aria-label="Open navigation"
              onClick={() => setSidebar(true)}
            >
              <Menu size={20} />
            </button>
            <button onClick={() => navigate('/')}>Workspace</button>
            <ChevronRight size={13} />
            {isGraph ? (
              <>
                {breadcrumbs.length ? (
                  breadcrumbs.map((task) => (
                    <button
                      key={task.id}
                      onClick={() => open(task.id)}
                      className={task.id === currentId ? 'current' : ''}
                    >
                      {task.title}
                    </button>
                  ))
                ) : (
                  <span className="current">Map</span>
                )}
              </>
            ) : (
              <span className="current">{isPrs ? 'Pull requests' : 'Overview'}</span>
            )}
          </div>
          <div className="topbar-right">
            <span className={`connection ${connectionError ? 'offline' : ''}`}>
              <span className="local-dot" />
              {connectionError ? 'Server offline' : 'Stored on your device'}
            </span>
            <button
              className="icon-button"
              aria-label="Quick guide"
              onClick={() => setModal({ type: 'help' })}
            >
              <CircleHelp size={18} />
            </button>
          </div>
        </header>
        {(error || connectionError) && (
          <div className="error-banner" role="alert">
            <span>{error || connectionError}</span>
            <button
              className="icon-button"
              aria-label="Dismiss error"
              onClick={() => {
                setError('');
                if (connectionError) void refresh();
              }}
            >
              {connectionError && !error ? <RefreshCw size={16} /> : <X size={16} />}
            </button>
          </div>
        )}
        {loading ? (
          <div className="loading">
            <LoaderCircle className="spin" size={24} />
            Finding a little clarity...
          </div>
        ) : isGraph ? (
          currentId && !current ? (
            <div className="empty-state">
              <Box size={40} />
              <h2>This task is no longer here.</h2>
              <p>It may have been deleted from another view or the CLI.</p>
              <button className="button" onClick={() => navigate('/')}>
                Back to overview
              </button>
            </div>
          ) : (
            <section className="graph-page">
              <div className="graph-heading">
                <div>
                  <button
                    className="back-link"
                    onClick={() => navigate(current?.parentId ? `/tasks/${current.parentId}` : '/')}
                  >
                    <ArrowLeft size={13} />
                    {current?.parentId ? 'Parent graph' : 'Overview'}
                  </button>
                  <div className="graph-title">
                    <h1>{current?.title ?? 'The bigger picture'}</h1>
                    {current && <Status status={current.status} />}
                  </div>
                  <p>
                    {current?.description ||
                      (current
                        ? 'Every step has a place. Not every step needs a connection.'
                        : 'Your top-level tasks, and how they depend on one another.')}
                  </p>
                </div>
                <div className="graph-heading-actions">
                  {current && (
                    <>
                      <button
                        className="icon-button"
                        aria-label="Edit container"
                        onClick={() => setModal({ type: 'edit', task: current })}
                      >
                        <Pencil size={17} />
                      </button>
                      <button
                        className="icon-button destructive"
                        aria-label="Delete container"
                        onClick={() => void previewDelete(current)}
                        disabled={busy}
                      >
                        <Trash2 size={17} />
                      </button>
                    </>
                  )}
                  <button
                    className="button primary"
                    onClick={() => setModal({ type: 'create', parentId: current?.id })}
                  >
                    <Plus size={16} />
                    {current ? 'Add step' : 'New task'}
                  </button>
                </div>
              </div>
              <div className="graph-toolbar">
                <div className="toolbar-tabs">
                  <span className="active">
                    <Network size={14} />
                    Graph
                  </span>
                  <span>{viewTasks.length} steps</span>
                  <span className="toolbar-complete">
                    {viewTasks.filter((task) => task.status === 'completed').length} completed
                  </span>
                </div>
                <div className="toolbar-actions">
                  {current && (
                    <button
                      className="text-button"
                      onClick={() => setModal({ type: 'reference', containerId: current.id })}
                    >
                      <Link2 size={14} />
                      Link task
                    </button>
                  )}
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() =>
                      saveLayout({
                        viewId,
                        mode: layout?.mode === 'manual' ? 'auto' : 'manual',
                        positions: layout?.positions ?? [],
                      })
                    }
                  >
                    <Settings2 size={14} />
                    {layout?.mode === 'manual' ? 'Manual layout' : 'Auto layout'}
                  </button>
                </div>
              </div>
              <div className="graph-workspace">
                <div className="graph-canvas">
                  {viewTasks.length ? (
                    <Graph
                      snapshot={snapshot}
                      viewId={viewId}
                      selectedId={selectedId}
                      onSelect={(id) => {
                        setSelectedId(id);
                        setEdgeId(null);
                      }}
                      onOpen={open}
                      onConnect={(connection) => {
                        if (connection.source && connection.target)
                          addDependency(connection.source, connection.target);
                      }}
                      onSelectEdge={(id) => {
                        setEdgeId(id);
                        setSelectedId(null);
                      }}
                      onLayout={saveLayout}
                    />
                  ) : (
                    <div className="empty-graph">
                      <div className="empty-graph-illustration">
                        <span />
                        <i />
                        <span />
                        <i />
                        <span />
                      </div>
                      <h2>A clear space for a messy idea.</h2>
                      <p>
                        Add a few steps. Connect what depends on what.
                        <br />
                        Leave everything else floating.
                      </p>
                      <button
                        className="button primary"
                        onClick={() => setModal({ type: 'create', parentId: current?.id })}
                      >
                        <Plus size={16} />
                        Add your first step
                      </button>
                      {current && (
                        <button
                          className="text-button"
                          onClick={() => setModal({ type: 'reference', containerId: current.id })}
                        >
                          or link an existing task
                          <ArrowUpRight size={13} />
                        </button>
                      )}
                    </div>
                  )}
                  {!!viewTasks.length && (
                    <div className="graph-hint">
                      <span className="local-dot" />
                      Drag between handles to connect. Click a step to inspect.
                    </div>
                  )}
                  {edge && (
                    <div className="edge-popover">
                      <div>
                        <strong>Prerequisite connection</strong>
                        <p>
                          {snapshot.tasks.find((task) => task.id === edge.prerequisiteId)?.title}
                          <ArrowRight size={14} />
                          {snapshot.tasks.find((task) => task.id === edge.dependentId)?.title}
                        </p>
                      </div>
                      <button
                        className="button danger-subtle"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await api(`/dependencies/${edge.id}`, 'DELETE');
                            setEdgeId(null);
                          })
                        }
                      >
                        <Trash2 size={14} />
                        Disconnect
                      </button>
                      <button
                        className="icon-button"
                        onClick={() => setEdgeId(null)}
                        aria-label="Close connection details"
                      >
                        <X size={15} />
                      </button>
                    </div>
                  )}
                </div>
                {selected && (
                  <Detail
                    key={selected.id}
                    task={selected}
                    snapshot={snapshot}
                    viewId={viewId}
                    busy={busy}
                    close={() => setSelectedId(null)}
                    edit={() => setModal({ type: 'edit', task: selected })}
                    open={open}
                    done={() =>
                      void run(() =>
                        api(`/tasks/${selected.id}/done`, 'POST', { done: !selected.manualDone }),
                      )
                    }
                    remove={() => void previewDelete(selected)}
                    unlink={(id) =>
                      void run(async () => {
                        await api(`/references/${id}`, 'DELETE');
                        setSelectedId(null);
                      })
                    }
                    addDependency={addDependency}
                    removeDependency={(id) => void run(() => api(`/dependencies/${id}`, 'DELETE'))}
                  />
                )}
              </div>
              <div className="graph-legend">
                {(['available', 'blocked', 'ready', 'completed'] as const).map((status) => (
                  <span key={status}>
                    <span className={`tiny-status tiny-${status}`} />
                    {statusLabels[status]}
                    {status === 'ready' && <small>Own work done, waiting</small>}
                  </span>
                ))}
                <span className="legend-layout">
                  {layout?.mode === 'manual'
                    ? 'Drag nodes to arrange. Changes are saved.'
                    : 'Automatically arranged'}
                </span>
              </div>
            </section>
          )
        ) : isPrs ? (
          <section className="page-content pr-page">
            <div className="page-heading">
              <div>
                <div className="eyebrow">OUT THERE, MOVING THINGS FORWARD</div>
                <h1>Your pull requests.</h1>
                <p>Your authored open PRs in one place. Any accessible PR can become a gate.</p>
              </div>
              <button
                className="button"
                disabled={busy || github?.syncing}
                onClick={() => void run(() => api('/github/sync', 'POST'))}
              >
                <RefreshCw size={15} className={github?.syncing ? 'spin' : ''} />
                Refresh GitHub
              </button>
            </div>
            <div className={`github-connection ${github?.configured ? '' : 'not-configured'}`}>
              <GitPullRequest size={25} />
              <div>
                <strong>
                  {github?.configured
                    ? github.login
                      ? `Connected as ${github.login}`
                      : 'Token configured'
                    : 'Connect GitHub when you are ready.'}
                </strong>
                <p>
                  {github?.configured ? (
                    github.lastSync ? (
                      `Last sync attempt ${new Date(github.lastSync).toLocaleString()}. Polling runs while the server is open.`
                    ) : (
                      'Waiting for the first sync.'
                    )
                  ) : (
                    <>
                      Set <code>GH_TOKEN</code> in your local <code>.env</code> and restart the
                      server. Your token never goes to the browser.
                    </>
                  )}
                </p>
              </div>
            </div>
            {github?.error && github.configured && (
              <div className="callout warning" role="status">
                {github.error} Cached results may be stale.
              </div>
            )}
            <div className="section-heading">
              <h2>
                Authored open PRs <span>{prs.length}</span>
              </h2>
              <button
                className="text-button"
                onClick={() => setModal({ type: 'create', prUrl: '' })}
              >
                <Plus size={14} />
                Link a PR by URL
              </button>
            </div>
            <div className="pr-list">
              {prs.length ? (
                prs.map((pr) => (
                  <article key={pr.url} className="pr-row">
                    <div className="pr-symbol">
                      <GitPullRequest size={21} />
                    </div>
                    <div className="pr-info">
                      <a href={pr.url} target="_blank" rel="noreferrer">
                        {pr.title}
                        <ArrowUpRight size={14} />
                      </a>
                      <p>
                        {pr.repository}
                        <span>#{pr.number}</span>
                        {pr.draft && <span className="draft">Draft</span>}
                      </p>
                    </div>
                    <button
                      className="button"
                      onClick={() => setModal({ type: 'create', prUrl: pr.url })}
                    >
                      <Plus size={14} />
                      Add merge gate
                    </button>
                  </article>
                ))
              ) : (
                <div className="empty-state compact">
                  <GitPullRequest size={32} />
                  <h2>
                    {github?.configured
                      ? 'Nothing open, nothing to juggle.'
                      : 'A home for your PRs.'}
                  </h2>
                  <p>
                    {github?.configured
                      ? 'No authored open PRs in the current cache. Refresh to check GitHub.'
                      : 'Connect your account to see authored PRs here. You can create gates by URL before connecting.'}
                  </p>
                </div>
              )}
            </div>
          </section>
        ) : (
          <section className="page-content overview">
            <div className="page-heading">
              <div>
                <div className="eyebrow">LESS IN YOUR HEAD. MORE IN VIEW.</div>
                <h1>A little room to think.</h1>
                <p>Your work, untangled. Pick a task and follow the thread.</p>
              </div>
              <button className="button primary" onClick={() => setModal({ type: 'create' })}>
                <Plus size={17} />
                New task
              </button>
            </div>
            <div className="overview-stats">
              <div>
                <span className="stat-symbol available-symbol">
                  <ArrowUpRight size={18} />
                </span>
                <strong>{available.toString().padStart(2, '0')}</strong>
                <span>
                  Available steps<small>Room to move forward</small>
                </span>
              </div>
              <div>
                <span className="stat-symbol waiting-symbol">
                  <GitPullRequest size={18} />
                </span>
                <strong>{ready.toString().padStart(2, '0')}</strong>
                <span>
                  Ready & waiting<small>Your part is already done</small>
                </span>
              </div>
              <div>
                <span className="stat-symbol complete-symbol">
                  <Check size={18} />
                </span>
                <strong>{complete.toString().padStart(2, '0')}</strong>
                <span>
                  Completed steps<small>One less thing to hold</small>
                </span>
              </div>
            </div>
            <div className="section-heading">
              <h2>
                On your mind <span>{roots.length}</span>
              </h2>
              <div className="search">
                <Search size={15} />
                <input
                  aria-label="Search tasks"
                  placeholder="Find a task..."
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
            </div>
            {filtered.length ? (
              <div className="task-grid">
                {filtered.map((task) => {
                  const children = snapshot.tasks.filter((child) =>
                    task.childrenIds.includes(child.id),
                  );
                  const count = children.filter((child) => child.status === 'completed').length;
                  const Icon =
                    task.kind === 'container'
                      ? Box
                      : task.kind === 'pr'
                        ? GitPullRequest
                        : ListChecks;
                  return (
                    <article className="task-card" key={task.id}>
                      <button className="card-main" onClick={() => open(task.id)}>
                        <div className="card-top">
                          <span className="card-icon">
                            <Icon size={20} />
                          </span>
                          <Status status={task.status} />
                        </div>
                        <h3>{task.title}</h3>
                        <p>
                          {task.description ||
                            (task.kind === 'container'
                              ? 'A place for the steps, waits, and small wins.'
                              : task.kind === 'pr'
                                ? task.prUrl
                                : 'One step closer to a clearer head.')}
                        </p>
                        {task.kind === 'container' && (
                          <div className="card-progress">
                            <span
                              style={{
                                width: `${children.length ? (count / children.length) * 100 : 0}%`,
                              }}
                            />
                          </div>
                        )}
                        <div className="card-meta">
                          <span>
                            {task.kind === 'container'
                              ? `${count} / ${children.length} steps complete`
                              : task.kind === 'pr'
                                ? 'Automatic merge gate'
                                : 'Manual step'}
                          </span>
                          <ArrowUpRight size={17} />
                        </div>
                      </button>
                      <div className="card-tools">
                        <button
                          className="icon-button"
                          aria-label={`Edit ${task.title}`}
                          onClick={() => setModal({ type: 'edit', task })}
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          className="icon-button"
                          aria-label={`Delete ${task.title}`}
                          onClick={() => void previewDelete(task)}
                          disabled={busy}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </article>
                  );
                })}
                <button className="new-task-card" onClick={() => setModal({ type: 'create' })}>
                  <span>
                    <Plus size={23} />
                  </span>
                  <strong>Make space for something new</strong>
                  <small>A big idea starts with one small step.</small>
                </button>
              </div>
            ) : query ? (
              <div className="empty-state compact">
                <Search size={28} />
                <h2>No matching tasks.</h2>
                <button className="text-button" onClick={() => setQuery('')}>
                  Clear search
                </button>
              </div>
            ) : (
              <div className="welcome">
                <div className="welcome-drawing">
                  <span className="sketch-node">
                    <ListChecks size={20} />
                  </span>
                  <span className="sketch-line" />
                  <span className="sketch-node center">
                    <GitPullRequest size={20} />
                  </span>
                  <span className="sketch-line" />
                  <span className="sketch-node">
                    <Check size={20} />
                  </span>
                  <span className="floating-sketch">
                    <Box size={17} />
                    Room for the loose ends, too.
                  </span>
                </div>
                <div className="welcome-copy">
                  <span className="eyebrow">START ANYWHERE</span>
                  <h2>
                    Big ideas.
                    <br />
                    Small, connected steps.
                  </h2>
                  <p>
                    Create a container for what you want to accomplish. Add manual steps, PR merge
                    gates, and links to other tasks. We'll keep track of what can happen next.
                  </p>
                  <button className="button primary" onClick={() => setModal({ type: 'create' })}>
                    Create your first task
                    <ArrowRight size={16} />
                  </button>
                </div>
              </div>
            )}
            <div className="overview-footnote">
              <ArrowDownRight size={17} />
              <span>
                Chains, branches, or a few loose ends. There is no one right shape for your work.
              </span>
              <button onClick={() => setModal({ type: 'help' })}>
                How it works
                <ArrowUpRight size={13} />
              </button>
            </div>
          </section>
        )}
      </main>

      {busy && (
        <div className="saving" role="status">
          <LoaderCircle size={13} className="spin" />
          Working...
        </div>
      )}
      <DialogErrorContext value={error}>
        {modal?.type === 'create' && (
          <TaskDialog
            parentId={modal.parentId}
            prUrl={modal.prUrl}
            snapshot={snapshot}
            prs={prs}
            github={github}
            close={() => setModal(null)}
            submit={saveTask}
            busy={busy}
          />
        )}
        {modal?.type === 'edit' && (
          <TaskDialog
            task={modal.task}
            snapshot={snapshot}
            prs={prs}
            github={github}
            close={() => setModal(null)}
            submit={saveTask}
            busy={busy}
          />
        )}
        {modal?.type === 'reference' && (
          <ReferenceDialog
            containerId={modal.containerId}
            snapshot={snapshot}
            close={() => setModal(null)}
            busy={busy}
            submit={(taskId) =>
              run(() => api('/references', 'POST', { containerId: modal.containerId, taskId }))
            }
          />
        )}
        {modal?.type === 'delete' && (
          <DeleteDialog
            task={modal.task}
            preview={modal.preview}
            snapshot={snapshot}
            close={() => setModal(null)}
            busy={busy}
            confirm={() =>
              void run(async () => {
                const fresh = await api<DeletionPreview>(
                  `/tasks/${modal.task.id}/deletion-preview`,
                );
                const fingerprint = (preview: DeletionPreview) =>
                  JSON.stringify({
                    ids: preview.taskIds.sort(),
                    affected: preview.affectedTasks
                      .map((task) => `${task.id}:${task.title}`)
                      .sort(),
                    dependencies: preview.removedDependencies.map((edge) => edge.id).sort(),
                    references: preview.removedReferences.map((ref) => ref.id).sort(),
                  });
                if (fingerprint(fresh) !== fingerprint(modal.preview)) {
                  setModal({ ...modal, preview: fresh });
                  throw new Error(
                    'The graph changed since this preview. Review the updated impact and confirm again.',
                  );
                }
                const result = await api<{ deleted: string[] }>(
                  `/tasks/${modal.task.id}?confirm=true`,
                  'DELETE',
                );
                setModal(null);
                if (currentId && result.deleted.includes(currentId)) navigate('/');
                if (selectedId && result.deleted.includes(selectedId)) setSelectedId(null);
              })
            }
          />
        )}
        {modal?.type === 'help' && (
          <Dialog title="A little guide to FoggyBrain" close={() => setModal(null)}>
            <div className="guide">
              <h3>Give your work a shape</h3>
              <p>
                Containers hold manual steps, GitHub merge gates, and shared tasks. Drag from a
                node's right handle to another node's left handle to make a prerequisite. Separate
                chains and floating steps are welcome.
              </p>
              <h3>Done on your side? Mark it done.</h3>
              <p>
                If prerequisites are unfinished, your step becomes <strong>Ready</strong>. It
                completes automatically once they finish. Containers complete when every child does.
                Reopening a step recalculates everything downstream.
              </p>
              <h3>A terminal-friendly brain</h3>
              <p>The UI and CLI share one local server. For source commands:</p>
              <pre>
                <code>
                  {
                    'pnpm foggy task list\npnpm foggy task create "Ship to stage" --kind container\npnpm --silent run foggy --json graph'
                  }
                </code>
              </pre>
              <p>
                After building, optionally run <code>pnpm link</code> to use <code>foggy</code>{' '}
                directly. Full command and agent documentation lives in <code>docs/cli.md</code>.
              </p>
              <h3>GitHub, without browser secrets</h3>
              <p>
                Set <code>GH_TOKEN</code> in the server's environment or local <code>.env</code>,
                then restart. Use a read-only token for the repositories you need. Merge checks run
                every minute while the server is running.
              </p>
              <h3>Arrange it your way</h3>
              <p>
                Auto layout keeps your graph tidy. Click the layout control to switch to manual
                positioning. Click it again to return to auto layout. Click connections to remove
                them.
              </p>
            </div>
            <footer>
              <button className="button primary" onClick={() => setModal(null)}>
                Back to a clearer head
                <ArrowRight size={15} />
              </button>
            </footer>
          </Dialog>
        )}
      </DialogErrorContext>
    </div>
  );
}
