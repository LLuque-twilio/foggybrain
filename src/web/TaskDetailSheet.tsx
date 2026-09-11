import type { ReactNode } from 'react';
import { Sheet, SheetContent, SheetTitle } from './components/ui/sheet';

export function TaskDetailSheet({
  title,
  close,
  children,
}: {
  title?: string;
  close: () => void;
  children?: ReactNode;
}) {
  return (
    <Sheet modal={false} open={Boolean(title)} onOpenChange={(isOpen) => !isOpen && close()}>
      {title && (
        <SheetContent
          className="task-detail-sheet"
          onInteractOutside={(event) => event.preventDefault()}
        >
          <SheetTitle className="sr-only">{title}</SheetTitle>
          {children}
        </SheetContent>
      )}
    </Sheet>
  );
}
