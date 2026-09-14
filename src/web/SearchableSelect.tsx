import { useId, useRef, useState, type ReactNode } from 'react';
import { LoadingField } from './LoadingField';
import { Command, CommandItem, CommandList } from './components/ui/command';
import { Input } from './components/ui/input';
import { Popover, PopoverAnchor, PopoverContent } from './components/ui/popover';

export interface SearchableSelectOption {
  value: string;
  label: string;
  id?: string;
}

export interface SearchableSelectProps {
  label: string;
  options: SearchableSelectOption[];
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
  renderOption?: (option: SearchableSelectOption) => ReactNode;
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
  const inputElement = useRef<HTMLInputElement>(null);
  const search =
    controlledSearch ??
    (value ? (options.find((entry) => entry.value === value)?.label ?? '') : input);
  const visible = options.filter((entry) =>
    entry.label.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const expanded = open && !disabled && !loading;
  const activeId =
    active >= 0 && active < visible.length
      ? `${id}-option-${visible[active].id ?? active}`
      : undefined;
  function select(entry: SearchableSelectOption, keyboard = false) {
    setInput('');
    onSearchChange?.(entry.label);
    onChange(entry.value);
    if (keyboard) {
      setOpen(false);
      setActive(-1);
    }
  }
  return (
    <>
      <Command className="repository-picker" shouldFilter={false}>
        <label id={`${id}-label`} htmlFor={id}>
          {label}
        </label>
        <Popover
          open={expanded}
          onOpenChange={(nextOpen) => {
            setOpen(nextOpen);
            if (!nextOpen) setActive(-1);
          }}
        >
          <LoadingField loading={loading}>
            <PopoverAnchor asChild>
              <Input
                ref={inputElement}
                className="transition-none"
                id={id}
                role="combobox"
                aria-autocomplete="list"
                aria-label={label}
                aria-busy={loading}
                aria-expanded={expanded}
                aria-controls={`${id}-list`}
                aria-activedescendant={activeId}
                aria-describedby={describedBy}
                autoComplete="off"
                required={required}
                value={search}
                disabled={disabled || loading}
                placeholder={placeholder}
                onFocus={() => setOpen(true)}
                onClick={() => setOpen(true)}
                onChange={(event) => {
                  const nextSearch = event.target.value;
                  setInput(nextSearch);
                  onSearchChange?.(nextSearch);
                  onChange('');
                  setOpen(true);
                  setActive(-1);
                }}
                onKeyDownCapture={(event) => {
                  if (event.key === 'Enter' && active < 0) {
                    event.preventDefault();
                    event.stopPropagation();
                  }
                }}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    event.stopPropagation();
                    setOpen(true);
                    setActive(
                      visible.length
                        ? active < 0 || active >= visible.length
                          ? event.key === 'ArrowDown'
                            ? 0
                            : visible.length - 1
                          : (active + (event.key === 'ArrowDown' ? 1 : -1) + visible.length) %
                            visible.length
                        : -1,
                    );
                  } else if (event.key === 'Enter') {
                    event.preventDefault();
                    event.stopPropagation();
                    if (active >= 0 && active < visible.length) select(visible[active], true);
                  } else if (event.key === 'Escape' && expanded) {
                    event.preventDefault();
                    event.stopPropagation();
                    event.nativeEvent.stopImmediatePropagation();
                    setOpen(false);
                    setActive(-1);
                  }
                }}
              />
            </PopoverAnchor>
          </LoadingField>
          <PopoverContent
            portalled={false}
            role="presentation"
            className="searchable-select-popover"
            align="start"
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
            onInteractOutside={(event) => {
              if (event.target === inputElement.current) event.preventDefault();
            }}
          >
            <CommandList
              id={`${id}-list`}
              ref={(element) => {
                if (element) element.id = `${id}-list`;
              }}
              aria-label={listLabel}
            >
              {visible.map((entry, index) => (
                <CommandItem
                  key={entry.value}
                  id={`${id}-option-${entry.id ?? index}`}
                  ref={(element) => {
                    if (element) element.id = `${id}-option-${entry.id ?? index}`;
                  }}
                  value={entry.value}
                  data-active={active === index}
                  onSelect={() => select(entry)}
                  onClick={() => {
                    setOpen(false);
                    setActive(-1);
                  }}
                >
                  <span>{renderOption ? renderOption(entry) : entry.label}</span>
                </CommandItem>
              ))}
            </CommandList>
          </PopoverContent>
        </Popover>
      </Command>
      {emptyMessage && !visible.length && <p role="status">{emptyMessage}</p>}
    </>
  );
}
