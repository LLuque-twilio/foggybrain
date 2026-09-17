import { createContext, useContext, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Box,
  GitPullRequest,
  Link2,
  ListChecks,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { Dialog as DialogPrimitive, DialogContent, DialogTitle } from './components/ui/dialog';
import { inferExternalLinkType } from '../external-links';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { RadioGroup, RadioGroupItem } from './components/ui/radio-group';
import { Textarea } from './components/ui/textarea';
import { LoadingField } from './LoadingField';
import { SearchableSelect } from './SearchableSelect';
import { TagPicker } from './Tags';
import {
  type ExternalLink,
  type ExternalLinkType,
  type CreateTaskInput,
  type DeletionPreview,
  type GithubPr,
  type GithubStatus,
  type Snapshot,
  type Tag,
  type TaskKind,
  type TaskView,
  type UpdateTaskInput,
} from '../shared';

const externalLinkTypes: { value: ExternalLinkType; label: string }[] = [
  { value: 'github', label: 'GitHub' },
  { value: 'jira', label: 'Jira' },
  { value: 'google-doc', label: 'Google Doc' },
  { value: 'generic', label: 'Generic' },
];

type ExternalLinkDraft = Omit<ExternalLink, 'type'> & {
  type: ExternalLinkType | '';
  inferType: boolean;
};

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
  const [externalLinks, setExternalLinks] = useState<ExternalLinkDraft[]>(
    task?.externalLinks?.map((link) => ({ ...link, inferType: false })) ?? [],
  );
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
          const submittedExternalLinks = externalLinks.map(({ inferType: _, ...link }) => link);
          const input = {
            title,
            description,
            ...(externalLinks.length ||
            (task &&
              JSON.stringify(submittedExternalLinks) !== JSON.stringify(task.externalLinks ?? []))
              ? { externalLinks: submittedExternalLinks as ExternalLink[] }
              : {}),
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
        <section className="external-links-editor">
          <div className="external-links-heading">
            <h3>External resources</h3>
            <span>{externalLinks.length} / 5</span>
          </div>
          <p className="form-hint">Add supporting tickets, documents, and reference material.</p>
          {externalLinks.map((link, index) => (
            <div className="external-link-editor" key={index}>
              <div className="external-link-editor-heading">
                <strong>Resource {index + 1}</strong>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="icon-button"
                  aria-label={`Remove resource ${index + 1}`}
                  onClick={() =>
                    setExternalLinks((current) => current.filter((_, item) => item !== index))
                  }
                >
                  <Trash2 size={14} />
                </Button>
              </div>
              <label>
                URL
                <Input
                  type="url"
                  required
                  maxLength={2048}
                  aria-label={`Resource ${index + 1} URL`}
                  placeholder="https://..."
                  value={link.url}
                  onChange={(event) => {
                    const nextUrl = event.target.value;
                    setExternalLinks((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index
                          ? {
                              ...item,
                              url: nextUrl,
                              type: item.inferType ? inferExternalLinkType(nextUrl) : item.type,
                            }
                          : item,
                      ),
                    );
                  }}
                />
              </label>
              <label>
                Label <span className="optional">optional</span>
                <Input
                  maxLength={100}
                  aria-label={`Resource ${index + 1} label`}
                  placeholder="e.g. Design document"
                  value={link.label}
                  onChange={(event) =>
                    setExternalLinks((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, label: event.target.value } : item,
                      ),
                    )
                  }
                />
              </label>
              <SearchableSelect
                label={`Resource ${index + 1} type`}
                options={externalLinkTypes}
                value={link.type}
                required
                onChange={(type) =>
                  setExternalLinks((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, type: type as ExternalLinkType | '', inferType: false }
                        : item,
                    ),
                  )
                }
              />
            </div>
          ))}
          {externalLinks.length < 5 && (
            <Button
              type="button"
              className="button full add-external-link"
              onClick={() =>
                setExternalLinks((current) => [
                  ...current,
                  { url: '', label: '', type: 'generic', inferType: true },
                ])
              }
            >
              <Plus size={15} />
              Add external resource
            </Button>
          )}
        </section>
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
              <Input
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
          <Button className="button" type="button" onClick={close}>
            Cancel
          </Button>
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
