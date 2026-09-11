import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Clock3,
  FilePenLine,
  GitMerge,
  GitPullRequestClosed,
  MessageSquare,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import type { PrMergeStatus, TaskView } from '../shared';
import { Badge } from './components/ui/badge';

const readiness = {
  unknown: { label: 'Readiness unknown', Icon: CircleDashed, tone: 'neutral' },
  draft: { label: 'Draft', Icon: FilePenLine, tone: 'neutral' },
  under_review: { label: 'Under review', Icon: MessageSquare, tone: 'review' },
  changes_requested: { label: 'Changes requested', Icon: MessageSquare, tone: 'warning' },
  checks_pending: { label: 'Checks pending', Icon: Clock3, tone: 'warning' },
  checks_failing: { label: 'Failing checks', Icon: XCircle, tone: 'danger' },
  conflicts: { label: 'Merge conflicts', Icon: AlertTriangle, tone: 'danger' },
  blocked: { label: 'Merge blocked', Icon: ShieldAlert, tone: 'warning' },
  ready: { label: 'Ready to merge', Icon: CheckCircle2, tone: 'success' },
} satisfies Record<PrMergeStatus, { label: string; Icon: typeof CircleDashed; tone: string }>;

export function PrStatus({ task }: { task: TaskView }) {
  const { label, Icon, tone } =
    task.prState === 'merged'
      ? { label: 'Merged', Icon: GitMerge, tone: 'merged' }
      : task.prState === 'closed'
        ? { label: 'Closed unmerged', Icon: GitPullRequestClosed, tone: 'danger' }
        : task.prState === 'unknown'
          ? { label: 'Not checked', Icon: CircleDashed, tone: 'neutral' }
          : readiness[task.prMergeStatus];
  const StatusIcon = task.prError ? AlertTriangle : Icon;
  return (
    <Badge
      className={`pr-status pr-status-${task.prError ? 'warning' : tone}`}
      title={
        task.prError
          ? `Last known PR status: ${label}. ${task.prError}`
          : `PR status: ${label}. Only a verified merge satisfies this gate.`
      }
    >
      <StatusIcon size={12} aria-hidden="true" />
      <span>
        {label}
        {task.prError ? ' (stale)' : ''}
      </span>
    </Badge>
  );
}
