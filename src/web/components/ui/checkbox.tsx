import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check } from 'lucide-react';
import type * as React from 'react';
import { cn } from '../../lib/utils';

function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        'peer size-4 shrink-0 rounded-[4px] border border-[#9aaa8d] bg-[#fcfdf8] shadow-sm outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-[#588466] disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-[#2e594a] data-[state=checked]:bg-[#2e594a] data-[state=checked]:text-[#f0f5e8]',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center"
      >
        <Check className="size-3.5" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
