import { useState } from 'react';
import { Check, Pencil, Plus, Star, Trash2, X } from 'lucide-react';
import type { Tag } from '../shared';
import { Badge } from './components/ui/badge';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';

const colors = ['#7c5cff', '#4f8a67', '#c06c4b', '#477ea8', '#a05f87', '#8a7b3f'];

function suggestedColor(name: string) {
  return colors[
    Array.from(name).reduce((total, character) => total + character.charCodeAt(0), 0) %
      colors.length
  ];
}

export function TagBadge({ tag }: { tag: Tag }) {
  return tag.system ? (
    <Badge variant="favorite" className="tag-badge favorite-badge">
      <Star size={10} fill="currentColor" />
      {tag.name}
    </Badge>
  ) : (
    <Badge className="tag-badge">
      <i style={{ backgroundColor: tag.color }} />
      {tag.name}
    </Badge>
  );
}

export function TagBadges({ tags, tagIds }: { tags: Tag[]; tagIds: string[] }) {
  return (
    <div className="tag-badges">
      {tagIds
        .map((id) => tags.find((tag) => tag.id === id))
        .filter(Boolean)
        .map((tag) => (
          <TagBadge key={tag!.id} tag={tag!} />
        ))}
    </div>
  );
}

export function StarToggle({
  starred,
  title,
  disabled,
  onToggle,
}: {
  starred: boolean;
  title: string;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className={`star-toggle ${starred ? 'is-starred' : ''}`}
      aria-label={`${starred ? 'Remove' : 'Add'} ${title} ${starred ? 'from' : 'to'} Favorites`}
      aria-pressed={starred}
      disabled={disabled}
      onClick={onToggle}
    >
      <Star size={17} fill={starred ? 'currentColor' : 'none'} />
    </Button>
  );
}

export function TagPicker({
  tags,
  selectedIds,
  busy,
  onAdd,
  onRemove,
  onCreate,
  onRename,
  onDelete,
}: {
  tags: Tag[];
  selectedIds: string[];
  busy: boolean;
  onAdd: (id: string) => void | Promise<void>;
  onRemove: (id: string) => void | Promise<void>;
  onCreate: (name: string, color: string) => Promise<Tag | undefined>;
  onRename: (id: string, name: string, color: string) => Promise<boolean>;
  onDelete: (tag: Tag) => void;
}) {
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [color, setColor] = useState(colors[0]);
  const [editing, setEditing] = useState<Tag | null>(null);
  const [editName, setEditName] = useState('');
  const [editColor, setEditColor] = useState('');
  const customTags = tags.filter((tag) => !tag.system);
  const selected = customTags.filter((tag) => selectedIds.includes(tag.id));
  const listed = customTags.filter((tag) =>
    tag.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const exact = customTags.some((tag) => tag.name.toLowerCase() === query.trim().toLowerCase());
  const atLimit = selected.length >= 3;

  return (
    <div className="tag-picker">
      <div className="tag-picker-chips">
        {selected.map((tag) => (
          <Badge className="tag-chip" key={tag.id}>
            <i style={{ backgroundColor: tag.color }} />
            {tag.name}
            <Button
              variant="ghost"
              size="icon"
              type="button"
              aria-label={`Remove tag ${tag.name}`}
              disabled={busy}
              onClick={() => void onRemove(tag.id)}
            >
              <X size={12} />
            </Button>
          </Badge>
        ))}
        {!selected.length && <span className="tag-picker-empty">No tags yet</span>}
      </div>
      <details>
        <summary
          className="button tag-picker-trigger"
          title={atLimit ? 'A task can have up to 3 tags. Favorites does not count.' : undefined}
          aria-disabled={atLimit || busy}
          onClick={(event) => {
            if (atLimit || busy) event.preventDefault();
          }}
        >
          <Plus size={13} />
          Add tag
        </summary>
        <div className="tag-picker-popover">
          <Input
            aria-label="Find or create a tag"
            placeholder="Find a tag..."
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setCreating(false);
            }}
          />
          <div className="tag-options" role="listbox" aria-label="Workspace tags">
            {listed.map((tag) =>
              editing?.id === tag.id ? (
                <div className="tag-edit-row" key={tag.id}>
                  <Input
                    aria-label={`Rename ${tag.name}`}
                    value={editName}
                    maxLength={40}
                    onChange={(event) => setEditName(event.target.value)}
                  />
                  <Input
                    aria-label={`Color for ${tag.name}`}
                    type="color"
                    value={editColor}
                    onChange={(event) => setEditColor(event.target.value)}
                  />
                  <Button
                    type="button"
                    className="icon-button"
                    aria-label={`Save ${tag.name}`}
                    disabled={busy || !editName.trim()}
                    onClick={async () => {
                      if (await onRename(tag.id, editName, editColor)) setEditing(null);
                    }}
                  >
                    <Check size={14} />
                  </Button>
                </div>
              ) : (
                <div
                  className="tag-option"
                  role="option"
                  aria-selected={selectedIds.includes(tag.id)}
                  key={tag.id}
                >
                  <Button
                    variant="ghost"
                    type="button"
                    disabled={busy || selectedIds.includes(tag.id)}
                    onClick={() => void onAdd(tag.id)}
                  >
                    <i style={{ backgroundColor: tag.color }} />
                    {tag.name}
                    {selectedIds.includes(tag.id) && <Check size={12} />}
                  </Button>
                  <Button
                    type="button"
                    className="icon-button"
                    aria-label={`Edit tag ${tag.name}`}
                    onClick={() => {
                      setEditing(tag);
                      setEditName(tag.name);
                      setEditColor(tag.color);
                    }}
                  >
                    <Pencil size={13} />
                  </Button>
                  <Button
                    type="button"
                    className="icon-button destructive"
                    aria-label={`Delete tag ${tag.name}`}
                    onClick={() => onDelete(tag)}
                  >
                    <Trash2 size={13} />
                  </Button>
                </div>
              ),
            )}
            {!listed.length && !query.trim() && <p className="muted">No workspace tags yet.</p>}
          </div>
          {query.trim() && !exact && !creating && (
            <Button
              variant="ghost"
              type="button"
              className="tag-create-offer"
              onClick={() => {
                setColor(suggestedColor(query.trim()));
                setCreating(true);
              }}
            >
              <Plus size={13} /> Create tag '{query.trim()}'
            </Button>
          )}
          {creating && (
            <div className="tag-create-row">
              <Input
                aria-label="New tag color"
                type="color"
                value={color}
                onChange={(event) => setColor(event.target.value)}
              />
              <Button
                type="button"
                className="button primary"
                disabled={busy}
                onClick={async () => {
                  const tag = await onCreate(query.trim(), color);
                  if (!tag) return;
                  await onAdd(tag.id);
                  setQuery('');
                  setCreating(false);
                }}
              >
                Create and add
              </Button>
            </div>
          )}
        </div>
      </details>
      <small>{selected.length} of 3 tags</small>
    </div>
  );
}
