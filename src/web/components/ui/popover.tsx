import * as PopoverPrimitive from '@radix-ui/react-popover';
import type * as React from 'react';
import { cn } from '../../lib/utils';

const Popover = PopoverPrimitive.Root;
const PopoverAnchor = PopoverPrimitive.Anchor;
const PopoverTrigger = PopoverPrimitive.Trigger;

function PopoverContent({
  className,
  align = 'center',
  sideOffset = 4,
  container,
  portalled = true,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content> & {
  container?: HTMLElement | null;
  portalled?: boolean;
}) {
  const content = (
    <PopoverPrimitive.Content
      data-slot="popover-content"
      align={align}
      sideOffset={sideOffset}
      className={cn(
        'z-50 outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
        className,
      )}
      {...props}
    />
  );
  return portalled ? (
    <PopoverPrimitive.Portal container={container}>{content}</PopoverPrimitive.Portal>
  ) : (
    content
  );
}

export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger };
