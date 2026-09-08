export type TaskKind = 'container' | 'manual' | 'pr';
export type TaskStatus = 'available' | 'blocked' | 'ready' | 'completed';
export type PrState = 'unknown' | 'open' | 'closed' | 'merged';

export interface Task {
  id: string;
  title: string;
  description: string;
  kind: TaskKind;
  parentId: string | null;
  manualDone: boolean;
  prUrl: string | null;
  prState: PrState;
  prCheckedAt: string | null;
  prError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskView extends Task {
  status: TaskStatus;
  ownSatisfied: boolean;
  waitingOn: string[];
  childrenIds: string[];
}

export interface Dependency {
  id: string;
  prerequisiteId: string;
  dependentId: string;
}

export interface TaskReference {
  id: string;
  containerId: string;
  taskId: string;
}

export interface Layout {
  viewId: string;
  mode: 'auto' | 'manual';
  positions: { nodeId: string; x: number; y: number }[];
}

export interface Snapshot {
  tasks: TaskView[];
  dependencies: Dependency[];
  references: TaskReference[];
  layouts: Layout[];
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  kind: TaskKind;
  parentId?: string | null;
  prUrl?: string;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  prUrl?: string;
}

export interface DeletionPreview {
  taskIds: string[];
  affectedTasks: TaskView[];
  removedDependencies: Dependency[];
  removedReferences: TaskReference[];
}

export interface GithubStatus {
  configured: boolean;
  login: string | null;
  lastSync: string | null;
  error: string | null;
  syncing: boolean;
}

export interface GithubPr {
  url: string;
  title: string;
  number: number;
  repository: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  updatedAt: string;
}
