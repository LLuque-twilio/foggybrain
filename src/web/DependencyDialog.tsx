import { useState } from 'react';
import { ArrowRight, Plus } from 'lucide-react';
import type { ConnectTaskInput, GithubPr, GithubStatus, Snapshot, Tag, TaskView } from '../shared';
import { Dialog, TaskDialog } from './Dialogs';
import { SearchableSelect } from './SearchableSelect';

export function DependencyDialog({
  task,
  direction,
  snapshot,
  prs,
  github,
  busy,
  close,
  clearError,
  submit,
  createTag,
  renameTag,
  deleteTag,
}: {
  task: TaskView;
  direction: ConnectTaskInput['direction'];
  snapshot: Snapshot;
  prs: GithubPr[];
  github: GithubStatus | null;
  busy: boolean;
  close: () => void;
  clearError: () => void;
  submit: (input: ConnectTaskInput) => Promise<boolean>;
  createTag: (name: string, color: string) => Promise<Tag | undefined>;
  renameTag: (id: string, name: string, color: string) => Promise<boolean>;
  deleteTag: (tag: Tag) => void;
}) {
  const [mode, setMode] = useState<'leaf' | 'chain'>('leaf');
  const [dependencyId, setDependencyId] = useState('');
  const [taskId, setTaskId] = useState('');
  const [creating, setCreating] = useState(false);
  const before = direction === 'prerequisite';
  const edges = snapshot.dependencies.filter((edge) =>
    before ? edge.dependentId === task.id : edge.prerequisiteId === task.id,
  );
  const edge = mode === 'chain' ? edges.find((edge) => edge.id === dependencyId) : undefined;
  const candidates = snapshot.tasks.filter(
    (candidate) =>
      candidate.id !== task.id &&
      (mode === 'leaf'
        ? !edges.some((edge) =>
            before ? edge.prerequisiteId === candidate.id : edge.dependentId === candidate.id,
          )
        : candidate.id !== (before ? edge?.prerequisiteId : edge?.dependentId)),
  );
  const selected = candidates.find((candidate) => candidate.id === taskId);
  const canConnect = mode === 'leaf' || !!edge;
  const connection = { direction, ...(mode === 'chain' ? { dependencyId } : {}) };
  const title = (id: string) =>
    snapshot.tasks.find((candidate) => candidate.id === id)?.title ?? id;

  if (creating) {
    return (
      <TaskDialog
        dialogTitle={`Create ${direction}`}
        submitLabel="Create and connect"
        initialKind="manual"
        parentId={task.parentId}
        snapshot={snapshot}
        prs={prs}
        github={github}
        busy={busy}
        createTag={createTag}
        renameTag={renameTag}
        deleteTag={deleteTag}
        close={() => {
          if (busy) return;
          clearError();
          setCreating(false);
        }}
        submit={async (input) => {
          if (!('kind' in input)) return false;
          const success = await submit({ ...connection, task: input });
          if (success) close();
          return success;
        }}
      />
    );
  }

  return (
    <Dialog title={`Add ${direction}`} close={close}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (!canConnect || !selected || busy) return;
          if (await submit({ ...connection, taskId })) close();
        }}
      >
        <p className="form-hint">
          {before ? 'Must finish before' : 'Waits for'} <strong>{task.title}</strong>.
        </p>
        <fieldset className="connection-mode" disabled={busy}>
          <legend>Placement</legend>
          <label>
            <input
              type="radio"
              name="placement"
              value="leaf"
              checked={mode === 'leaf'}
              onChange={() => {
                setMode('leaf');
                setTaskId('');
              }}
            />
            <span>
              Insert as new leaf<small>Add a connection without changing other branches.</small>
            </span>
          </label>
          <label>
            <input
              type="radio"
              name="placement"
              value="chain"
              checked={mode === 'chain'}
              disabled={!edges.length}
              onChange={() => {
                setMode('chain');
                setTaskId('');
              }}
            />
            <span>
              Insert in existing chain
              <small>Split one connection; keep other branches as they are.</small>
            </span>
          </label>
        </fieldset>
        {!edges.length && (
          <p className="form-hint">
            No {before ? 'incoming' : 'outgoing'} connections to insert into yet.
          </p>
        )}
        {mode === 'chain' && (
          <SearchableSelect
            label="Connection to split"
            placeholder="Choose a chain connection"
            options={edges.map((edge) => ({
              value: edge.id,
              label: `${title(edge.prerequisiteId)} \u2192 ${title(edge.dependentId)}`,
            }))}
            value={dependencyId}
            onChange={(id) => {
              setDependencyId(id);
              setTaskId('');
            }}
            disabled={busy}
          />
        )}
        <SearchableSelect
          key={`${mode}-${dependencyId}`}
          label={`Existing ${direction}`}
          placeholder="Type to filter tasks..."
          options={candidates.map((candidate) => ({
            value: candidate.id,
            label: candidate.title,
          }))}
          value={taskId}
          onChange={setTaskId}
          disabled={busy || !canConnect}
          emptyMessage="No matching tasks. Create a new task instead."
        />
        {selected && canConnect && (
          <p className="connection-preview" role="status">
            {before
              ? `${edge ? `${title(edge.prerequisiteId)} \u2192 ` : ''}${selected.title} \u2192 ${task.title}`
              : `${task.title} \u2192 ${selected.title}${edge ? ` \u2192 ${title(edge.dependentId)}` : ''}`}
          </p>
        )}
        <button
          className="button full"
          type="button"
          disabled={busy || !canConnect}
          onClick={() => {
            clearError();
            setCreating(true);
          }}
        >
          <Plus size={15} />
          Create new task or PR
        </button>
        <footer>
          <button className="button" type="button" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={busy || !canConnect || !selected}
          >
            Connect {direction}
            <ArrowRight size={15} />
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
