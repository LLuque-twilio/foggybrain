import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { LoadingField } from './LoadingField';
import { Input } from './components/ui/input';

export interface SearchableSelectProps {
  label: string;
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  id?: string;
  listLabel?: string;
  required?: boolean;
  loading?: boolean;
  describedBy?: string;
  search?: string;
  onSearchChange?: (search: string) => void;
  renderOption?: (option: { value: string; label: string }) => ReactNode;
  emptyMessage?: string;
}

export function SearchableSelect({
  label,
  options,
  value,
  onChange,
  disabled = false,
  placeholder,
  id: providedId,
  listLabel = label,
  required = false,
  loading = false,
  describedBy,
  search: controlledSearch,
  onSearchChange,
  renderOption,
  emptyMessage,
}: SearchableSelectProps) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const [input, setInput] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const list = useRef<HTMLUListElement>(null);
  const search =
    controlledSearch ??
    (value ? (options.find((entry) => entry.value === value)?.label ?? '') : input);
  const visible = options.filter((entry) =>
    entry.label.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const expanded = open && !disabled && !loading;
  const highlighted = expanded && active >= 0 && active < visible.length;
  const highlightedValue = highlighted ? visible[active].value : undefined;
  useEffect(() => {
    if (highlighted)
      list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, highlighted, highlightedValue]);
  function select(entry: { value: string; label: string }) {
    setInput('');
    onSearchChange?.(entry.label);
    onChange(entry.value);
    setOpen(false);
    setActive(-1);
  }
  return (
    <>
      <div className="repository-picker">
        <label htmlFor={id}>{label}</label>
        <LoadingField loading={loading}>
          <Input
            id={id}
            role="combobox"
            aria-autocomplete="list"
            aria-busy={loading}
            aria-expanded={expanded}
            aria-controls={`${id}-list`}
            aria-describedby={describedBy}
            aria-activedescendant={highlighted ? `${id}-${active}` : undefined}
            autoComplete="off"
            required={required}
            value={search}
            disabled={disabled || loading}
            placeholder={placeholder}
            onFocus={() => setOpen(true)}
            onClick={() => setOpen(true)}
            onBlur={() => {
              setOpen(false);
              setActive(-1);
            }}
            onChange={(event) => {
              setInput(event.target.value);
              onSearchChange?.(event.target.value);
              onChange('');
              setOpen(true);
              setActive(-1);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                setOpen(true);
                setActive(
                  visible.length
                    ? !expanded || active < 0 || active >= visible.length
                      ? event.key === 'ArrowDown'
                        ? 0
                        : visible.length - 1
                      : (active + (event.key === 'ArrowDown' ? 1 : -1) + visible.length) %
                        visible.length
                    : -1,
                );
              } else if (event.key === 'Enter') {
                event.preventDefault();
                if (highlighted) select(visible[active]);
              } else if (event.key === 'Escape' && expanded) {
                event.preventDefault();
                event.stopPropagation();
                event.nativeEvent.stopImmediatePropagation();
                setOpen(false);
                setActive(-1);
              }
            }}
          />
        </LoadingField>
        <ul id={`${id}-list`} ref={list} role="listbox" aria-label={listLabel} hidden={!expanded}>
          {visible.map((entry, index) => (
            <li
              key={entry.value}
              id={`${id}-${index}`}
              role="option"
              aria-selected={value === entry.value}
              data-active={active === index}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => select(entry)}
            >
              {renderOption ? renderOption(entry) : entry.label}
            </li>
          ))}
        </ul>
      </div>
      {emptyMessage && !visible.length && <p role="status">{emptyMessage}</p>}
    </>
  );
}
