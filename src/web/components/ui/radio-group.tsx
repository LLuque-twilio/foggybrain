import * as RadioGroupPrimitive from '@radix-ui/react-radio-group';
import { Circle } from 'lucide-react';
import type * as React from 'react';
import { cn } from '../../lib/utils';

function RadioGroup({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return (
    <RadioGroupPrimitive.Root
      data-slot="radio-group"
      className={cn('grid gap-3', className)}
      {...props}
    />
  );
}

function RadioGroupItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      className={cn(
        'aspect-square size-4 shrink-0 rounded-full border border-[#9aaa8d] bg-[#fcfdf8] text-[#2e594a] shadow-sm outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-[#588466] disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator
        data-slot="radio-group-indicator"
        className="grid place-content-center"
      >
        <Circle className="size-2 fill-current" />
      </RadioGroupPrimitive.Indicator>
      {children}
    </RadioGroupPrimitive.Item>
  );
}

export { RadioGroup, RadioGroupItem };
