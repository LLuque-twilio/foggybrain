export type TaskKind = 'container' | 'manual' | 'pr';
export type TaskStatus = 'available' | 'blocked' | 'ready' | 'completed';
export type PrState = 'unknown' | 'open' | 'closed' | 'merged';
export type PrMergeStatus =
  | 'unknown'
  | 'draft'
  | 'under_review'
  | 'changes_requested'
  | 'checks_pending'
  | 'checks_failing'
  | 'conflicts'
  | 'blocked'
  | 'ready';

export interface Task {
  id: string;
  title: string;
  description: string;
  kind: TaskKind;
  parentId: string | null;
  manualDone: boolean;
  prUrl: string | null;
  prState: PrState;
  prMergeStatus: PrMergeStatus;
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

export interface ConnectTaskInput {
  direction: 'prerequisite' | 'dependent';
  taskId?: string;
  task?: CreateTaskInput;
  dependencyId?: string;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  prUrl?: string | null;
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

export type PortableTask = Pick<
  Task,
  'id' | 'title' | 'description' | 'kind' | 'parentId' | 'manualDone' | 'prUrl'
>;

export interface PortableState {
  version: 1;
  tasks: PortableTask[];
  dependencies: Dependency[];
  references: TaskReference[];
}

export interface SyncTarget {
  repo: string;
  branch: string;
  path: string;
}

export interface Workspace {
  id: string;
  name: string;
  type: 'local' | 'cloud';
  target: SyncTarget | null;
  credential: 'dedicated' | 'github' | null;
}

export interface WorkspaceList {
  workspaces: Workspace[];
  defaultWorkspaceId: string | null;
  limit: number;
}

export interface WorkspaceRemovalPreview {
  workspace: Workspace;
  taskCount: number;
  dependencyCount: number;
  referenceCount: number;
  dirty: boolean;
  canRemove: boolean;
  reason: string | null;
  revision: string;
}

export interface WorkspaceRepositories {
  login: string;
  repositories: { id: number; fullName: string; defaultBranch: string }[];
}

export interface WorkspaceBranches {
  branches: string[];
}

export interface WorkspaceFiles {
  paths: string[];
}

export function safeSyncRef(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 512 &&
    /^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/.test(value) &&
    !value.includes('..') &&
    !value
      .split('/')
      .some((part) => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))
  );
}

export interface CreateWorkspaceInput {
  name: string;
  type: 'local' | 'cloud';
  target?: SyncTarget;
  credential?: 'dedicated' | 'github';
}

export interface UpdateWorkspaceInput {
  name?: string;
  type?: 'cloud';
  target?: SyncTarget;
  credential?: 'dedicated' | 'github';
}

export interface SyncStatus {
  configured: boolean;
  target: SyncTarget | null;
  lastSync: string | null;
  dirty: boolean;
  syncing: boolean;
}

export interface SyncChange {
  collection: 'tasks' | 'dependencies' | 'references';
  id: string;
  title?: string;
  kind: 'added' | 'updated' | 'deleted';
}

export interface SyncConflict {
  path: string;
  base: unknown;
  local: unknown;
  remote: unknown;
}

export interface SyncPreview {
  mode: 'merge' | 'revert';
  previewId: string;
  target: SyncTarget;
  localChanges: SyncChange[];
  remoteChanges: SyncChange[];
  conflicts: SyncConflict[];
  validationError: string | null;
  canApply: boolean;
  resolution: 'local' | 'remote' | null;
}
