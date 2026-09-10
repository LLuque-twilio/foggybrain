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
  tagIds: string[];
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

export interface Tag {
  id: string;
  name: string;
  /** @pattern ^#[0-9a-fA-F]{6}$ */
  color: string;
  system: boolean;
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
  tags: Tag[];
  layouts: Layout[];
}

export interface CreateTaskInput {
  /** @pattern \S */
  title: string;
  description?: string;
  kind: TaskKind;
  parentId?: string | null;
  prUrl?: string;
  tagIds?: string[];
}

export interface ConnectTaskInput {
  direction: 'prerequisite' | 'dependent';
  taskId?: string;
  task?: CreateTaskInput;
  /** @pattern \S */
  dependencyId?: string;
}

/** @minProperties 1 */
export interface UpdateTaskInput {
  /** @pattern \S */
  title?: string;
  description?: string;
  prUrl?: string | null;
  tagIds?: string[];
}

export interface CreateTagInput {
  /** @minLength 1 @maxLength 40 */
  name: string;
  /** @pattern ^#[0-9a-fA-F]{6}$ */
  color: string;
}

/** @minProperties 1 */
export interface UpdateTagInput {
  /** @minLength 1 @maxLength 40 */
  name?: string;
  /** @pattern ^#[0-9a-fA-F]{6}$ */
  color?: string;
}

export interface SetTaskTagsInput {
  /** @maxItems 3 @uniqueItems true */
  tagIds: string[];
}

export interface TagDeletionPreview {
  tag: Tag;
  affectedTasks: TaskView[];
}

export interface DeleteTagResponse {
  detachedTaskIds: string[];
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
  'id' | 'title' | 'description' | 'kind' | 'parentId' | 'manualDone' | 'prUrl' | 'tagIds'
>;

export interface PortableState {
  version: 2;
  tasks: PortableTask[];
  dependencies: Dependency[];
  references: TaskReference[];
  tags: Tag[];
}

/** @pattern ^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?/(?!\.{1,2}$)[a-zA-Z0-9_.-]+$ */
export type SyncRepository = string;

/**
 * @maxLength 512
 * @pattern ^(?!.*\.\.)(?!.*\/\/)(?!.*\/\.)(?!.*\.(?:lock)?(?:/|$))(?!.*\/$)[a-zA-Z0-9_][a-zA-Z0-9_./-]*$
 */
export type SyncRef = string;

export interface SyncTarget {
  repo: SyncRepository;
  branch: SyncRef;
  path: SyncRef;
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
  /** The server enforces a trimmed length of 1 to 100 UTF-16 code units.
   * @pattern \S
   */
  name: string;
  type: 'local' | 'cloud';
  target?: SyncTarget;
  credential?: 'dedicated' | 'github';
}

export interface UpdateWorkspaceInput {
  /** The server enforces a trimmed length of 1 to 100 UTF-16 code units.
   * @pattern \S
   */
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
  collection: 'tasks' | 'dependencies' | 'references' | 'tags';
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

export type GithubPrList = GithubPr[];

export type EmptyBody = Record<string, never>;

export interface SetDoneInput {
  done: boolean;
}

export type CreateDependencyInput = Pick<Dependency, 'prerequisiteId' | 'dependentId'>;
export type CreateReferenceInput = Pick<TaskReference, 'containerId' | 'taskId'>;

export interface DeleteTaskResponse {
  deleted: string[];
}

export interface ErrorResponse {
  error: string;
}

export interface OkResponse {
  ok: true;
}

/** Health also names the process, so `foggy start` can tell its own child from a port squatter. */
export interface HealthResponse {
  ok: true;
  pid: number;
}

export interface RemoveWorkspaceInput {
  /** @pattern \S */
  revision: string;
}

export interface SyncPreviewInput {
  mode?: 'merge' | 'revert';
  resolution?: 'local' | 'remote';
}

export interface SyncApplyInput {
  /** @pattern \S */
  previewId: string;
  confirm: true;
}

export interface ConfirmDeletionQuery {
  confirm: 'true';
}

export interface RepositoryDiscoveryQuery {
  /** Dedicated uses only server FOGGY_SYNC_TOKEN (default); github explicitly reuses
   * server GH_TOKEN, GITHUB_TOKEN, or gh auth token. Never accepts browser credentials.
   */
  credential?: 'dedicated' | 'github';
}

export interface BranchDiscoveryQuery {
  /** Dedicated uses only server FOGGY_SYNC_TOKEN; github explicitly opts into server GitHub credentials. */
  credential: 'dedicated' | 'github';
  repo: SyncTarget['repo'];
}

export interface FileDiscoveryQuery extends BranchDiscoveryQuery {
  branch: SyncTarget['branch'];
}
