import type * as React from 'react';
import { cn } from '../../lib/utils';

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'flex min-h-20 w-full rounded-md border border-[#bbc9b0] bg-[#f7f9f0] px-3 py-2 text-sm shadow-sm outline-none transition-colors placeholder:text-[#65715f] placeholder:italic focus-visible:ring-2 focus-visible:ring-[#588466] disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
