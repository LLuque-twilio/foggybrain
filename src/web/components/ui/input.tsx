import type * as React from 'react';
import { cn } from '../../lib/utils';

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'flex h-9 w-full rounded-md border border-[#bbc9b0] bg-[#f7f9f0] px-3 py-1 text-sm shadow-sm outline-none transition-colors placeholder:text-[#65715f] placeholder:italic focus-visible:ring-2 focus-visible:ring-[#588466] disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
