import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';
import { cn } from '../../lib/utils';

const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border px-2 py-0.5 text-[10px] font-medium whitespace-nowrap',
  {
    variants: {
      variant: {
        default: 'border-[var(--line)] bg-[var(--surface-subtle)] text-[var(--muted)]',
        favorite:
          'border-[var(--favorite-border)] bg-[var(--favorite-surface)] text-[var(--favorite-text)]',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return (
    <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
