import { useState } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  Copy,
  GitPullRequest,
  Link2,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import type { ConnectTaskInput, Snapshot, Tag, TaskView } from '../shared';
import { Status } from './Status';
import { PrStatus } from './PrStatus';
import { StarToggle, TagBadges, TagPicker } from './Tags';

export function Detail({
  task,
  snapshot,
  viewId,
  busy,
  close,
  edit,
  open,
  done,
  remove,
  unlink,
  addDependency,
  removeDependency,
  toggleTag,
  createTag,
  renameTag,
  deleteTag,
}: {
  task: TaskView;
  snapshot: Snapshot;
  viewId: string;
  busy: boolean;
  close: () => void;
  edit: () => void;
  open: (id: string) => void;
  done: () => void;
  remove: () => void;
  unlink: (id: string) => void;
  addDependency: (direction: ConnectTaskInput['direction']) => void;
  removeDependency: (id: string) => void;
  toggleTag: (tagId: string, attached: boolean) => void;
  createTag: (name: string, color: string) => Promise<Tag | undefined>;
  renameTag: (id: string, name: string, color: string) => Promise<boolean>;
  deleteTag: (tag: Tag) => void;
}) {
  const [copied, setCopied] = useState(false);
  const incoming = snapshot.dependencies.filter((edge) => edge.dependentId === task.id);
  const outgoing = snapshot.dependencies.filter((edge) => edge.prerequisiteId === task.id);
  const reference = snapshot.references.find(
    (ref) => ref.containerId === viewId && ref.taskId === task.id,
  );
  const memberships = snapshot.references.filter((ref) => ref.taskId === task.id);
  return (
    <aside className="detail-panel" aria-label="Task details">
      <div className="detail-top">
        <span className="eyebrow">{reference ? 'SHARED TASK' : 'TASK DETAILS'}</span>
        <div>
          <StarToggle
            starred={task.tagIds.includes('favorites')}
            title={task.title}
            disabled={busy}
            onToggle={() => toggleTag('favorites', !task.tagIds.includes('favorites'))}
          />
          <button className="icon-button" onClick={close} aria-label="Close task details">
            <X size={18} />
          </button>
        </div>
      </div>
      <Status status={task.status} />
      <h2>{task.title}</h2>
      <TagBadges tags={snapshot.tags} tagIds={task.tagIds} />
      <div className="detail-actions">
        <button className="text-button" onClick={edit}>
          <Pencil size={13} />
          Edit task
        </button>
        <button
          className="text-button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(task.id);
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
          title={task.id}
        >
          <Copy size={13} />
          {copied ? 'ID copied' : 'Copy ID'}
        </button>
      </div>
      <p className="description">
        {task.description || 'No description. Add a little context with Edit task.'}
      </p>
      <section className="detail-section detail-tags">
        <h3>Tags</h3>
        <TagPicker
          tags={snapshot.tags}
          selectedIds={task.tagIds}
          busy={busy}
          onAdd={(id) => toggleTag(id, true)}
          onRemove={(id) => toggleTag(id, false)}
          onCreate={createTag}
          onRename={renameTag}
          onDelete={deleteTag}
        />
      </section>
      {task.status === 'ready' && (
        <div className="callout ready-callout">
          <Check size={16} />
          <span>
            Own work done. This will complete automatically when its prerequisites finish.
          </span>
        </div>
      )}
      {task.kind === 'manual' && (
        <button
          className={`button full ${task.manualDone ? '' : 'primary'}`}
          disabled={busy}
          onClick={done}
        >
          {task.manualDone ? <RotateCcw size={16} /> : <Check size={16} />}
          {task.manualDone ? 'Reopen own work' : 'Mark own work done'}
        </button>
      )}
      {task.kind === 'container' && (
        <>
          <button className="button full primary" onClick={() => open(task.id)}>
            Open task graph
            <ArrowUpRight size={16} />
          </button>
          <p className="form-hint">
            {
              snapshot.tasks.filter(
                (child) => task.childrenIds.includes(child.id) && child.status === 'completed',
              ).length
            }{' '}
            of {task.childrenIds.length} steps complete. All owned and referenced children count.
          </p>
        </>
      )}
      {task.prUrl && (
        <div className="pr-detail">
          {task.kind === 'manual' && (
            <p className="form-hint">
              PR gate: completion requires both manual work done and a verified merge.
            </p>
          )}
          <a className="button full" href={task.prUrl!} target="_blank" rel="noreferrer">
            <GitPullRequest size={16} />
            View PR on GitHub
            <ArrowUpRight size={15} />
          </a>
          <p>
            Merge status: <PrStatus task={task} />
          </p>
          <small className="muted">
            {task.prCheckedAt
              ? `Last check: ${new Date(task.prCheckedAt).toLocaleString()}`
              : 'Waiting for first check. Polling runs while the server is open.'}
          </small>
          {task.prError && (
            <div className="callout warning">{task.prError} Last verified state is retained.</div>
          )}
        </div>
      )}
      <section className="detail-section">
        <h3>
          Prerequisites <span>{incoming.length}</span>
        </h3>
        {!incoming.length && (
          <p className="form-hint">No prerequisites. This step can stand on its own.</p>
        )}
        {incoming.map((edge) => {
          const source = snapshot.tasks.find((candidate) => candidate.id === edge.prerequisiteId)!;
          return (
            <div className="relationship" key={edge.id}>
              <button onClick={() => open(source.id)}>
                <span>{source.title}</span>
                <Status status={source.status} />
              </button>
              <button
                className="icon-button"
                disabled={busy}
                onClick={() => removeDependency(edge.id)}
                aria-label={`Remove prerequisite ${source.title}`}
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
        <button
          className="button full"
          disabled={busy}
          onClick={() => addDependency('prerequisite')}
          aria-haspopup="dialog"
        >
          <Plus size={16} />
          Add prerequisite
        </button>
      </section>
      <section className="detail-section">
        <h3>
          Unblocks <span>{outgoing.length}</span>
        </h3>
        {!outgoing.length && <p className="form-hint">No downstream steps yet.</p>}
        {outgoing.map((edge) => {
          const target = snapshot.tasks.find((candidate) => candidate.id === edge.dependentId)!;
          return (
            <div className="relationship" key={edge.id}>
              <button onClick={() => open(target.id)}>
                <span>{target.title}</span>
                <ArrowRight size={14} />
              </button>
              <button
                className="icon-button"
                disabled={busy}
                onClick={() => removeDependency(edge.id)}
                aria-label={`Remove dependency to ${target.title}`}
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
        <button
          className="button full"
          disabled={busy}
          onClick={() => addDependency('dependent')}
          aria-haspopup="dialog"
        >
          <Plus size={16} />
          Add dependent
        </button>
      </section>
      {(task.parentId || memberships.length > 0) && (
        <section className="detail-section">
          <h3>Lives in</h3>
          {[
            ...(task.parentId ? [task.parentId] : []),
            ...memberships.map((ref) => ref.containerId),
          ].map((id) => (
            <button className="membership" key={id} onClick={() => open(id)}>
              <Link2 size={13} />
              {snapshot.tasks.find((candidate) => candidate.id === id)?.title}
              <ArrowUpRight size={13} />
            </button>
          ))}
        </section>
      )}
      <div className="detail-footer">
        {reference && (
          <button className="button full" disabled={busy} onClick={() => unlink(reference.id)}>
            <Link2 size={14} />
            Unlink from this graph
          </button>
        )}
        <button className="text-button destructive" onClick={remove} disabled={busy}>
          <Trash2 size={14} />
          Delete {task.kind === 'container' ? 'container' : 'task'} everywhere
        </button>
      </div>
    </aside>
  );
}
