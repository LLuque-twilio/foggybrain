import { useEffect, useState, type ReactNode } from 'react';
import { Search, Star } from 'lucide-react';
import type { Snapshot, Tag, TaskView } from '../shared';
import { Detail } from './Detail';
import { StarToggle, TagBadges } from './Tags';
import { TaskDetailSheet } from './TaskDetailSheet';

const kindLabels = { container: 'Container', manual: 'Manual step', pr: 'PR merge' };

export function ListView({
  snapshot,
  query,
  setQuery,
  selected,
  busy,
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
  open: (id: string) => void;
  close: () => void;
  detail: (task: TaskView) => ReactNode;
  toggleFavorite: (task: TaskView) => void;
}) {
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
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
      (!selectedTags.length || selectedTags.some((id) => task.tagIds.includes(id)))
    );
  });
  const toggleFilter = (tag: Tag) =>
    setSelectedTags((current) =>
      current.includes(tag.id) ? current.filter((id) => id !== tag.id) : [...current, tag.id],
    );
  const favorite = snapshot.tags.find((tag) => tag.id === 'favorites');

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
            <input
              aria-label="Search all tasks"
              placeholder="Find a task..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="filter-tags" aria-label="Filter by tags">
            {favorite && (
              <button
                className="favorite-filter"
                aria-pressed={selectedTags.includes(favorite.id)}
                onClick={() => toggleFilter(favorite)}
              >
                <Star size={12} fill="currentColor" /> Favorites
              </button>
            )}
            {snapshot.tags
              .filter((tag) => !tag.system)
              .map((tag) => (
                <button
                  key={tag.id}
                  aria-pressed={selectedTags.includes(tag.id)}
                  onClick={() => toggleFilter(tag)}
                >
                  <i style={{ backgroundColor: tag.color }} /> {tag.name}
                </button>
              ))}
          </div>
          {!!selectedTags.length && (
            <button className="text-button" onClick={() => setSelectedTags([])}>
              Clear filters
            </button>
          )}
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
