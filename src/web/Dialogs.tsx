import { createContext, useContext, useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowRight, Box, GitPullRequest, Link2, ListChecks, X } from 'lucide-react';
import { Dialog as DialogPrimitive, DialogContent, DialogTitle } from './components/ui/dialog';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { RadioGroup, RadioGroupItem } from './components/ui/radio-group';
import { Textarea } from './components/ui/textarea';
import { ExternalLinkFields, PrUrlFields, type ExternalLinkDraft } from './TaskFields';
import { TagPicker } from './Tags';
import {
  type ExternalLink,
  type CreateTaskInput,
  type DeletionPreview,
  type GithubPr,
  type GithubStatus,
  type Snapshot,
  type Tag,
  type TaskKind,
  type TaskView,
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
  const error = useContext(DialogErrorContext);
  return (
    <DialogPrimitive open onOpenChange={(open) => !open && close()}>
      <DialogContent
        className={`dialog ${danger ? 'dialog-danger' : ''}`}
        aria-label={title}
        showCloseButton={false}
        onEscapeKeyDown={(event) => {
          if (event.target instanceof HTMLElement && event.target.matches('[role="combobox"]')) {
            event.preventDefault();
          }
        }}
      >
        <header>
          <DialogTitle>{title}</DialogTitle>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="icon-button"
            onClick={close}
            aria-label="Close dialog"
          >
            <X size={19} />
          </Button>
        </header>
        {error && (
          <div className="callout warning" role="alert">
            {error}
          </div>
        )}
        {children}
      </DialogContent>
    </DialogPrimitive>
  );
}

export function TaskDialog({
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
  parentId?: string | null;
  prUrl?: string;
  snapshot: Snapshot;
  prs: GithubPr[];
  github: GithubStatus | null;
  close: () => void;
  submit: (input: CreateTaskInput) => Promise<boolean>;
  busy: boolean;
  dialogTitle?: string;
  submitLabel?: string;
  initialKind?: TaskKind;
  createTag: (name: string, color: string) => Promise<Tag | undefined>;
  renameTag: (id: string, name: string, color: string) => Promise<boolean>;
  deleteTag: (tag: Tag) => void;
}) {
  const [kind, setKind] = useState<TaskKind>(
    initialKind ?? (prUrl !== undefined ? 'pr' : parentId ? 'manual' : 'container'),
  );
  const [title, setTitle] = useState(prUrl ? `Merge PR #${prUrl.split('/').pop()}` : '');
  const [description, setDescription] = useState('');
  const [url, setUrl] = useState(prUrl ?? '');
  const [externalLinks, setExternalLinks] = useState<ExternalLinkDraft[]>([]);
  const [parent, setParent] = useState(parentId ?? '');
  const [tagIds, setTagIds] = useState<string[]>([]);
  return (
    <Dialog title={dialogTitle ?? (parentId ? 'Add a step' : 'Make a little space')} close={close}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          const submittedExternalLinks = externalLinks.map(({ inferType: _, ...link }) => link);
          const input = {
            title,
            description,
            ...(externalLinks.length
              ? { externalLinks: submittedExternalLinks as ExternalLink[] }
              : {}),
            ...(kind === 'pr'
              ? { prUrl: url }
              : kind === 'manual'
                ? url.trim()
                  ? { prUrl: url }
                  : {}
                : {}),
            kind,
            parentId: parent || null,
            tagIds,
          };
          if (await submit(input as CreateTaskInput)) close();
        }}
      >
        <section className="task-form-section task-type-section">
          <div className="task-form-section-heading">
            <div>
              <h3>Choose a task type</h3>
              <p>Set how this work reaches completion.</p>
            </div>
          </div>
          <RadioGroup
            className="kind-picker"
            aria-label="Task type"
            value={kind}
            onValueChange={(value) => setKind(value as TaskKind)}
          >
            {(
              [
                ['manual', ListChecks, 'Manual step'],
                ['pr', GitPullRequest, 'PR merge'],
                ['container', Box, 'Container'],
              ] as const
            ).map(([value, Icon, label]) => (
              <RadioGroupItem className="size-auto aspect-auto" key={value} value={value}>
                <Icon size={18} />
                {label}
              </RadioGroupItem>
            ))}
          </RadioGroup>
          <p className="form-hint task-type-hint">
            {kind === 'container'
              ? 'A home for connected chains, independent steps, and other task graphs.'
              : kind === 'pr'
                ? 'An automatic gate. This step is satisfied when GitHub confirms the PR is merged.'
                : 'A step you mark done yourself, even before its prerequisites finish.'}
          </p>
        </section>
        <section className="task-form-section">
          <div className="task-form-section-heading">
            <div>
              <h3>Task details</h3>
              <p>Give this work a clear, recognizable name.</p>
            </div>
          </div>
          <label>
            Summary
            <Input
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
            <Textarea
              placeholder="Keep useful context out of your head."
              rows={3}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
        </section>
        <section className="task-form-section external-links-editor">
          <div className="external-links-heading">
            <div>
              <h3>External resources</h3>
              <p>Add supporting tickets, documents, and reference material.</p>
            </div>
            <span>{externalLinks.length} / 5</span>
          </div>
          <ExternalLinkFields links={externalLinks} setLinks={setExternalLinks} />
        </section>
        {kind !== 'container' && (
          <section className="task-form-section">
            <div className="task-form-section-heading">
              <div>
                <h3>Completion</h3>
                <p>
                  {kind === 'pr'
                    ? 'Connect the pull request that completes this task.'
                    : 'Optionally require a merged pull request too.'}
                </p>
              </div>
            </div>
            <PrUrlFields
              kind={kind as Exclude<TaskKind, 'container'>}
              url={url}
              setUrl={setUrl}
              prs={prs}
              github={github}
              onSelect={(selected) => {
                if (!title.trim())
                  setTitle(`${kind === 'pr' ? 'Merge ' : ''}${selected.title}`.slice(0, 300));
              }}
            />
          </section>
        )}
        <section className="task-form-section">
          <div className="task-form-section-heading">
            <div>
              <h3>Organization</h3>
              <p>Place this task where you will find it again.</p>
            </div>
          </div>
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
        </section>
        <footer>
          <Button className="button" type="button" onClick={close}>
            Cancel
          </Button>
          <button className="button primary" disabled={busy} type="submit">
            {submitLabel ?? 'Create task'}
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
        <Button className="button" onClick={close}>
          Keep tag
        </Button>
        <Button className="button danger" disabled={busy} onClick={confirm}>
          Delete tag
        </Button>
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
        <Input
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
        <Button className="button" onClick={close}>
          Cancel
        </Button>
        <Button
          className="button primary"
          disabled={!chosen || busy}
          onClick={async () => {
            if (await submit(chosen)) close();
          }}
        >
          Link task
          <Link2 size={15} />
        </Button>
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
        <Button className="button" onClick={close}>
          Keep task
        </Button>
        <Button className="button danger" disabled={busy} onClick={confirm}>
          Delete permanently
        </Button>
      </footer>
    </Dialog>
  );
}
