import type * as React from 'react';
import { cn } from '../../lib/utils';

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'flex h-9 w-full rounded-md border border-[var(--line-strong)] bg-[var(--surface)] px-3 py-1 text-sm text-[var(--text)] shadow-sm outline-none transition-colors placeholder:text-[var(--muted)] placeholder:italic focus-visible:ring-3 focus-visible:ring-[var(--focus)] disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
