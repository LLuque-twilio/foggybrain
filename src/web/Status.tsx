import { Check, Circle, Clock3, LockKeyhole } from 'lucide-react';
import type { TaskStatus } from '../shared';

export const statusLabels: Record<TaskStatus, string> = {
  available: 'Available',
  blocked: 'Blocked',
  ready: 'Ready',
  completed: 'Completed',
};

export function Status({ status }: { status: TaskStatus }) {
  const Icon = { available: Circle, blocked: LockKeyhole, ready: Clock3, completed: Check }[status];
  return (
    <span
      className={`status status-${status}`}
      title={status === 'ready' ? 'Own work done; waiting on prerequisites' : statusLabels[status]}
    >
      <Icon size={12} strokeWidth={2} />
      {statusLabels[status]}
    </span>
  );
}
