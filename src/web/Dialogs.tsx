import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { AlertTriangle, ArrowRight, Box, GitPullRequest, Link2, ListChecks, X } from 'lucide-react';
import { LoadingField } from './LoadingField';
import { TagPicker } from './Tags';
import type {
  CreateTaskInput,
  DeletionPreview,
  GithubPr,
  GithubStatus,
  Snapshot,
  Tag,
  TaskKind,
  TaskView,
  UpdateTaskInput,
} from '../shared';

export const DialogErrorContext = createContext('');

export function Dialog({
  title,
  close,
  children,
  danger = false,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
  danger?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const backdropPointer = useRef<number | null>(null);
  const error = useContext(DialogErrorContext);
  function isBackdrop(event: PointerEvent<HTMLDialogElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return (
      event.target === event.currentTarget &&
      (event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom)
    );
  }
  useEffect(() => {
    const element = ref.current!;
    element.showModal();
    return () => element.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog ${danger ? 'dialog-danger' : ''}`}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onPointerDown={(event) => {
        backdropPointer.current =
          event.isPrimary && event.button === 0 && isBackdrop(event) ? event.pointerId : null;
      }}
      onPointerUp={(event) => {
        const startedOnBackdrop = backdropPointer.current === event.pointerId;
        backdropPointer.current = null;
        if (startedOnBackdrop && isBackdrop(event)) close();
      }}
      onPointerCancel={() => {
        backdropPointer.current = null;
      }}
    >
      <header>
        <h2>{title}</h2>
        <button className="icon-button" onClick={close} aria-label="Close dialog">
          <X size={19} />
        </button>
      </header>
      {error && (
        <div className="callout warning" role="alert">
          {error}
        </div>
      )}
      {children}
    </dialog>
  );
}

export function TaskDialog({
  task,
  parentId,
  prUrl,
  snapshot,
  prs,
  github,
  close,
  submit,
  busy,
  dialogTitle,
  submitLabel,
  initialKind,
  createTag,
  renameTag,
  deleteTag,
}: {
  task?: TaskView;
  parentId?: string | null;
  prUrl?: string;
  snapshot: Snapshot;
  prs: GithubPr[];
  github: GithubStatus | null;
  close: () => void;
  submit: (
    input: CreateTaskInput | UpdateTaskInput,
    id?: string,
    customTagIds?: string[],
  ) => Promise<boolean>;
  busy: boolean;
  dialogTitle?: string;
  submitLabel?: string;
  initialKind?: TaskKind;
  createTag: (name: string, color: string) => Promise<Tag | undefined>;
  renameTag: (id: string, name: string, color: string) => Promise<boolean>;
  deleteTag: (tag: Tag) => void;
}) {
  const [kind, setKind] = useState<TaskKind>(
    task?.kind ?? initialKind ?? (prUrl !== undefined ? 'pr' : parentId ? 'manual' : 'container'),
  );
  const [title, setTitle] = useState(
    task?.title ?? (prUrl ? `Merge PR #${prUrl.split('/').pop()}` : ''),
  );
  const [description, setDescription] = useState(task?.description ?? '');
  const [url, setUrl] = useState(task?.prUrl ?? prUrl ?? '');
  const [parent, setParent] = useState(parentId ?? '');
  const [tagIds, setTagIds] = useState(task?.tagIds.filter((id) => id !== 'favorites') ?? []);
  const githubLoading = !github || github.syncing;
  return (
    <Dialog
      title={dialogTitle ?? (task ? 'Edit task' : parentId ? 'Add a step' : 'Make a little space')}
      close={close}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          const input = {
            title,
            description,
            ...(kind === 'pr'
              ? { prUrl: url }
              : kind === 'manual'
                ? url.trim()
                  ? { prUrl: url }
                  : task
                    ? { prUrl: null }
                    : {}
                : {}),
            ...(!task ? { kind, parentId: parent || null, tagIds } : {}),
          };
          if (await submit(input as CreateTaskInput | UpdateTaskInput, task?.id, tagIds)) close();
        }}
      >
        {!task && (
          <div className="kind-picker" role="group" aria-label="Task type">
            {(
              [
                ['manual', ListChecks, 'Manual step'],
                ['pr', GitPullRequest, 'PR merge'],
                ['container', Box, 'Container'],
              ] as const
            ).map(([value, Icon, label]) => (
              <button
                key={value}
                type="button"
                className={kind === value ? 'active' : ''}
                onClick={() => setKind(value)}
                aria-pressed={kind === value}
              >
                <Icon size={18} />
                {label}
              </button>
            ))}
          </div>
        )}
        <p className="form-hint">
          {kind === 'container'
            ? 'A home for connected chains, independent steps, and other task graphs.'
            : kind === 'pr'
              ? 'An automatic gate. This step is satisfied when GitHub confirms the PR is merged.'
              : 'A step you mark done yourself, even before its prerequisites finish.'}
        </p>
        <label>
          Summary
          <input
            required
            autoFocus
            placeholder={
              kind === 'container' ? 'e.g. Ship the new API to stage' : 'What needs to happen?'
            }
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={300}
          />
        </label>
        <label>
          Description <span className="optional">optional</span>
          <textarea
            placeholder="Keep useful context out of your head."
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        {kind !== 'container' && (
          <>
            <label>
              Your open pull requests
              <LoadingField loading={githubLoading}>
                <select
                  aria-busy={githubLoading}
                  aria-describedby="pr-discovery-hint"
                  value={prs.some((pr) => pr.url === url) ? url : ''}
                  onChange={(event) => {
                    const selected = prs.find((pr) => pr.url === event.target.value);
                    setUrl(event.target.value);
                    if (selected && !title.trim())
                      setTitle(`${kind === 'pr' ? 'Merge ' : ''}${selected.title}`.slice(0, 300));
                  }}
                >
                  <option value="">Select a PR or enter a URL below</option>
                  {prs.map((pr) => (
                    <option key={pr.url} value={pr.url}>
                      {pr.repository} #{pr.number}: {pr.title}
                      {pr.draft ? ' (draft)' : ''}
                    </option>
                  ))}
                </select>
              </LoadingField>
            </label>
            <p className="form-hint" id="pr-discovery-hint" role="status">
              {!github
                ? 'Loading GitHub status... You can also enter a URL below.'
                : !github.configured
                  ? 'GitHub is not connected. You can still enter a PR URL below.'
                  : github.error
                    ? `GitHub sync failed: ${github.error}. Listed PRs may be stale; you can enter a URL below.`
                    : github.syncing
                      ? 'Refreshing your open pull requests... You can also enter a URL below.'
                      : !prs.length
                        ? 'No authored open pull requests found. Enter a PR URL below.'
                        : 'Choose one of your authored PRs, or enter any GitHub PR URL below.'}
            </p>
            <label>
              GitHub PR URL
              {kind === 'manual' && <span className="optional">optional</span>}
              <input
                type="url"
                required={kind === 'pr'}
                placeholder="https://github.com/owner/repo/pull/123"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
            </label>
            {kind === 'manual' && (
              <p className="form-hint">
                With a PR gate, both your manual work and a verified PR merge are required. Clear
                the URL to remove the gate.
              </p>
            )}
          </>
        )}
        {!task && (
          <label>
            Lives in
            <select value={parent} onChange={(event) => setParent(event.target.value)}>
              <option value="">Workspace (top level)</option>
              {snapshot.tasks
                .filter((task) => task.kind === 'container')
                .map((task) => (
                  <option key={task.id} value={task.id}>
                    {task.title}
                  </option>
                ))}
            </select>
          </label>
        )}
        <label>
          Tags <span className="optional">optional</span>
        </label>
        <TagPicker
          tags={snapshot.tags}
          selectedIds={tagIds}
          busy={busy}
          onAdd={(id) => setTagIds((current) => [...current, id])}
          onRemove={(id) => setTagIds((current) => current.filter((tagId) => tagId !== id))}
          onCreate={createTag}
          onRename={renameTag}
          onDelete={deleteTag}
        />
        <footer>
          <button className="button" type="button" onClick={close}>
            Cancel
          </button>
          <button className="button primary" disabled={busy} type="submit">
            {submitLabel ?? (task ? 'Save changes' : 'Create task')}
            <ArrowRight size={15} />
          </button>
        </footer>
      </form>
    </Dialog>
  );
}

export function TagDeleteDialog({
  tag,
  affectedTasks,
  close,
  confirm,
  busy,
}: {
  tag: Tag;
  affectedTasks: TaskView[];
  close: () => void;
  confirm: () => void;
  busy: boolean;
}) {
  return (
    <Dialog title="Delete this tag?" close={close} danger>
      <div className="delete-heading">
        <AlertTriangle size={24} />
        <p>
          <strong>{tag.name}</strong>
          <br />
          This tag will be removed from {affectedTasks.length} task
          {affectedTasks.length === 1 ? '' : 's'}. The tasks themselves will be kept.
        </p>
      </div>
      {!!affectedTasks.length && (
        <div className="impact-list">
          {affectedTasks.map((task) => (
            <div key={task.id}>
              <Box size={16} />
              <span>
                {task.title}
                <small>{task.kind}</small>
              </span>
            </div>
          ))}
        </div>
      )}
      <footer>
        <button className="button" onClick={close}>
          Keep tag
        </button>
        <button className="button danger" disabled={busy} onClick={confirm}>
          Delete tag
        </button>
      </footer>
    </Dialog>
  );
}

export function ReferenceDialog({
  containerId,
  snapshot,
  close,
  submit,
  busy,
}: {
  containerId: string;
  snapshot: Snapshot;
  close: () => void;
  submit: (taskId: string) => Promise<boolean>;
  busy: boolean;
}) {
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState('');
  const container = snapshot.tasks.find((task) => task.id === containerId)!;
  const candidates = snapshot.tasks.filter(
    (task) =>
      task.id !== containerId &&
      !container.childrenIds.includes(task.id) &&
      task.title.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <Dialog title="Link an existing task" close={close}>
      <p className="form-hint">
        A reference shares the original task's progress. It counts toward this container's
        completion, without moving or copying the task.
      </p>
      <label>
        Find a task
        <input
          autoFocus
          placeholder="Search by summary..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="reference-options">
        {candidates.length ? (
          candidates.map((task) => (
            <button
              key={task.id}
              className={chosen === task.id ? 'chosen' : ''}
              onClick={() => setChosen(task.id)}
            >
              <Link2 size={16} />
              <span>
                {task.title}
                <small>
                  {task.kind} / {task.id.slice(0, 8)}
                </small>
              </span>
              <span className="radio-mark" />
            </button>
          ))
        ) : (
          <p className="muted">No matching tasks. Create another task first.</p>
        )}
      </div>
      <footer>
        <button className="button" onClick={close}>
          Cancel
        </button>
        <button
          className="button primary"
          disabled={!chosen || busy}
          onClick={async () => {
            if (await submit(chosen)) close();
          }}
        >
          Link task
          <Link2 size={15} />
        </button>
      </footer>
    </Dialog>
  );
}

export function DeleteDialog({
  task,
  preview,
  snapshot,
  close,
  confirm,
  busy,
}: {
  task: TaskView;
  preview: DeletionPreview;
  snapshot: Snapshot;
  close: () => void;
  confirm: () => void;
  busy: boolean;
}) {
  return (
    <Dialog title="Delete this task?" close={close} danger>
      <div className="delete-heading">
        <AlertTriangle size={24} />
        <p>
          <strong>{task.title}</strong>
          <br />
          This deletes{' '}
          {preview.taskIds.length === 1
            ? 'this task'
            : `this task and ${preview.taskIds.length - 1} owned step${preview.taskIds.length === 2 ? '' : 's'}`}
          . This cannot be undone.
        </p>
      </div>
      {preview.taskIds.length > 1 && (
        <details>
          <summary>Tasks being deleted ({preview.taskIds.length})</summary>
          <ul>
            {preview.taskIds.map((id) => (
              <li key={id}>{snapshot.tasks.find((task) => task.id === id)?.title ?? id}</li>
            ))}
          </ul>
        </details>
      )}
      <h3>Other tasks affected</h3>
      <p className="form-hint">
        Dependencies and references to deleted tasks will be removed. The tasks below may unblock,
        complete, or reopen.
      </p>
      <div className="impact-list">
        {preview.affectedTasks.length ? (
          preview.affectedTasks.map((task) => (
            <div key={task.id}>
              <Box size={16} />
              <span>
                {task.title}
                <small>{task.kind}</small>
              </span>
            </div>
          ))
        ) : (
          <p className="muted">No other tasks depend on this task.</p>
        )}
      </div>
      <p className="form-hint">
        {preview.removedDependencies.length} dependency connections and{' '}
        {preview.removedReferences.length} references will be removed. Independently owned reference
        targets are kept.
      </p>
      <footer>
        <button className="button" onClick={close}>
          Keep task
        </button>
        <button className="button danger" disabled={busy} onClick={confirm}>
          Delete permanently
        </button>
      </footer>
    </Dialog>
  );
}
