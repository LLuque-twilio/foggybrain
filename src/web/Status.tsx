import { Check, Circle, Clock3, LockKeyhole } from 'lucide-react';
import type { TaskStatus } from '../shared';
import { Badge } from './components/ui/badge';

export const statusLabels: Record<TaskStatus, string> = {
  available: 'Available',
  blocked: 'Blocked',
  ready: 'Ready',
  completed: 'Completed',
};

export function Status({ status }: { status: TaskStatus }) {
  const Icon = { available: Circle, blocked: LockKeyhole, ready: Clock3, completed: Check }[status];
  return (
    <Badge
      className={`status status-${status}`}
      title={status === 'ready' ? 'Own work done; waiting on prerequisites' : statusLabels[status]}
    >
      <Icon size={12} strokeWidth={2} />
      {statusLabels[status]}
    </Badge>
  );
}
