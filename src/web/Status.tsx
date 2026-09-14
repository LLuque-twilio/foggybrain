import { Check, Circle, Clock3, LockKeyhole } from 'lucide-react';
import type { TaskStatus } from '../shared';
import { Badge } from './components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from './components/ui/tooltip';

export const statusLabels: Record<TaskStatus, string> = {
  available: 'Available',
  blocked: 'Blocked',
  ready: 'Ready',
  completed: 'Completed',
};

export function Status({ status }: { status: TaskStatus }) {
  const Icon = { available: Circle, blocked: LockKeyhole, ready: Clock3, completed: Check }[status];
  const description =
    status === 'ready' ? 'Own work done; waiting on prerequisites' : statusLabels[status];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          className={`status status-${status}`}
          aria-label={`${statusLabels[status]}: ${description}`}
        >
          <Icon size={12} strokeWidth={2} aria-hidden="true" />
          {statusLabels[status]}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{description}</TooltipContent>
    </Tooltip>
  );
}
