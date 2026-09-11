import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import type { Snapshot, TaskKind, TaskStatus, TaskView } from '../shared';
import { Button } from './components/ui/button';
import { Checkbox } from './components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from './components/ui/dropdown-menu';
import { Input } from './components/ui/input';
import { Detail } from './Detail';
import { statusLabels } from './Status';
import { StarToggle, TagBadges } from './Tags';
import { TaskDetailSheet } from './TaskDetailSheet';

const kindLabels: Record<TaskKind, string> = {
  container: 'Container',
  manual: 'Manual step',
  pr: 'PR merge',
};
const kinds = Object.keys(kindLabels) as TaskKind[];
const statuses = Object.keys(statusLabels) as TaskStatus[];

function FilterMenu<T extends string>({
  label,
  options,
  selected,
  setSelected,
}: {
  label: string;
  options: { value: T; label: string; marker?: string }[];
  selected: T[];
  setSelected: (selected: T[]) => void;
}) {
  const toggle = (value: T) =>
    setSelected(
      selected.includes(value)
        ? selected.filter((selectedValue) => selectedValue !== value)
        : [...selected, value],
    );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button className="list-filter-trigger" aria-label={`${label} filter`}>
          {label}
          {selected.length > 0 && <span className="filter-count">{selected.length}</span>}
          <ChevronDown size={13} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" aria-label={`Filter by ${label.toLowerCase()}`}>
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        {options.map((option) => (
          <DropdownMenuCheckboxItem
            key={option.value}
            checked={selected.includes(option.value)}
            onCheckedChange={() => toggle(option.value)}
            onSelect={(event) => event.preventDefault()}
          >
            {option.marker && <i style={{ backgroundColor: option.marker }} />}
            {option.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ListView({
  snapshot,
  query,
  setQuery,
  selected,
  busy,
  savedHideCompleted,
  saveHideCompleted,
  open,
  close,
  detail,
  toggleFavorite,
}: {
  snapshot: Snapshot;
  query: string;
  setQuery: (value: string) => void;
  selected?: TaskView;
  busy: boolean;
  savedHideCompleted: boolean;
  saveHideCompleted: (hideCompleted: boolean) => Promise<boolean>;
  open: (id: string) => void;
  close: () => void;
  detail: (task: TaskView) => ReactNode;
  toggleFavorite: (task: TaskView) => void;
}) {
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedKinds, setSelectedKinds] = useState<TaskKind[]>([]);
  const [selectedStatuses, setSelectedStatuses] = useState<TaskStatus[]>([]);
  const [hideCompleted, setHideCompleted] = useState(savedHideCompleted);
  useEffect(() => setHideCompleted(savedHideCompleted), [savedHideCompleted]);
  useEffect(() => {
    setSelectedTags((current) =>
      current.filter((id) => snapshot.tags.some((tag) => tag.id === id)),
    );
  }, [snapshot.tags]);
  const filtered = snapshot.tasks.filter((task) => {
    const text = query.trim().toLowerCase();
    return (
      (!text ||
        task.title.toLowerCase().includes(text) ||
        task.description.toLowerCase().includes(text)) &&
      (!selectedTags.length || selectedTags.some((id) => task.tagIds.includes(id))) &&
      (!selectedKinds.length || selectedKinds.includes(task.kind)) &&
      (!selectedStatuses.length || selectedStatuses.includes(task.status)) &&
      (!hideCompleted || task.status !== 'completed')
    );
  });
  const filtersChanged =
    selectedTags.length > 0 || selectedKinds.length > 0 || selectedStatuses.length > 0;
  const resetFilters = () => {
    setSelectedTags([]);
    setSelectedKinds([]);
    setSelectedStatuses([]);
  };

  return (
    <section className="list-page">
      <div className="list-main">
        <div className="page-heading">
          <div>
            <div className="eyebrow">EVERY THREAD, IN ONE PLACE</div>
            <h1>Your task list.</h1>
            <p>Search across containers and steps, then filter by any tag.</p>
          </div>
          <span className="list-count">
            {filtered.length} of {snapshot.tasks.length}
          </span>
        </div>
        <div className="list-filters">
          <label className="list-search">
            <Search size={15} />
            <Input
              aria-label="Search all tasks"
              placeholder="Find a task..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="filter-menus">
            <FilterMenu
              label="Tags"
              options={snapshot.tags.map((tag) => ({
                value: tag.id,
                label: tag.name,
                marker: tag.system ? undefined : tag.color,
              }))}
              selected={selectedTags}
              setSelected={setSelectedTags}
            />
            <FilterMenu
              label="Type"
              options={kinds.map((kind) => ({ value: kind, label: kindLabels[kind] }))}
              selected={selectedKinds}
              setSelected={setSelectedKinds}
            />
            <FilterMenu
              label="Status"
              options={statuses.map((status) => ({ value: status, label: statusLabels[status] }))}
              selected={selectedStatuses}
              setSelected={setSelectedStatuses}
            />
          </div>
          {filtersChanged && (
            <Button variant="link" size="sm" className="text-button" onClick={resetFilters}>
              Reset filters
            </Button>
          )}
          <label className="hide-completed-filter">
            <Checkbox
              checked={hideCompleted}
              disabled={busy}
              onCheckedChange={(checked) => {
                const next = checked === true;
                setHideCompleted(next);
                void saveHideCompleted(next).then((saved) => {
                  if (!saved) setHideCompleted(savedHideCompleted);
                });
              }}
            />
            Hide completed?
          </label>
        </div>
        <div className="task-list" role="table" aria-label="All tasks">
          <div className="task-list-head" role="row">
            <span aria-hidden="true" />
            <span>Status</span>
            <span>Task</span>
            <span>Kind</span>
            <span>Tags</span>
          </div>
          {filtered.map((task) => (
            <div
              className={`task-list-row ${selected?.id === task.id ? 'selected' : ''}`}
              role="row"
              tabIndex={0}
              key={task.id}
              onClick={() => open(task.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  open(task.id);
                }
              }}
            >
              <span role="cell" onClick={(event) => event.stopPropagation()}>
                <StarToggle
                  starred={task.tagIds.includes('favorites')}
                  title={task.title}
                  disabled={busy}
                  onToggle={() => toggleFavorite(task)}
                />
              </span>
              <span role="cell">
                <i className={`tiny-status tiny-${task.status}`} />
                <span className="mobile-cell-label">{task.status}</span>
              </span>
              <span role="cell" className="list-task-title">
                <span>
                  <strong>{task.title}</strong>
                  {task.description && <small>{task.description}</small>}
                </span>
              </span>
              <span role="cell" className="list-kind">
                {kindLabels[task.kind]}
              </span>
              <span role="cell">
                <TagBadges tags={snapshot.tags} tagIds={task.tagIds} />
              </span>
            </div>
          ))}
          {!filtered.length && <div className="list-empty">No tasks match these filters.</div>}
        </div>
      </div>
      <TaskDetailSheet title={selected?.title} close={close}>
        {selected && detail(selected)}
      </TaskDetailSheet>
    </section>
  );
}
