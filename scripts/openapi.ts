import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import SwaggerParser from '@apidevtools/swagger-parser';
import { createGenerator } from 'ts-json-schema-generator';
import { format } from 'prettier';

export interface Schema {
  [keyword: string]: unknown;
  $ref?: string;
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  description?: string;
}

export interface Parameter {
  name: string;
  in: 'path' | 'query';
  required: boolean;
  description?: string;
  schema: Schema;
}

export interface Response {
  description: string;
  headers?: Record<string, { description: string; schema: Schema }>;
  content: { 'application/json': { schema: Schema } };
}

export interface Operation {
  operationId: string;
  summary: string;
  description: string;
  parameters: Parameter[];
  requestBody?: { required: boolean; content: { 'application/json': { schema: Schema } } };
  responses: Record<string, Response>;
  'x-query-policy': 'declared-only' | 'undeclared-ignored';
}

export type HttpMethod = 'get' | 'post' | 'patch' | 'put' | 'delete';

export interface OpenApiDocument {
  openapi: '3.1.0';
  info: { title: string; version: string; description: string };
  servers: { url: string }[];
  externalDocs: { description: string; url: string };
  paths: Record<string, Partial<Record<HttpMethod, Operation>>>;
  components: { schemas: Record<string, Schema> };
}

interface Route {
  method: HttpMethod;
  path: string;
  id: string;
  summary: string;
  response: string;
  body?: string;
  optionalBody?: boolean;
  status?: 201;
  query?: string;
  strictQuery?: boolean;
  errors?: number[];
  description?: string;
}

const management: Route[] = [
  {
    method: 'get',
    path: '/health',
    id: 'health',
    summary: 'Check server health',
    response: 'HealthResponse',
  },
  {
    method: 'get',
    path: '/workspaces',
    id: 'listWorkspaces',
    summary: 'List local workspace registrations',
    response: 'WorkspaceList',
  },
  {
    method: 'post',
    path: '/workspaces',
    id: 'createWorkspace',
    summary: 'Create a local or cloud workspace',
    body: 'CreateWorkspaceInput',
    response: 'Workspace',
    status: 201,
    errors: [409, 503],
    description:
      'Saves configuration only; does not fetch or publish remote state. The first workspace becomes the default.',
  },
  {
    method: 'get',
    path: '/workspaces/repositories',
    id: 'listWorkspaceRepositories',
    summary: 'Discover private user-owned repositories',
    response: 'WorkspaceRepositories',
    query: 'RepositoryDiscoveryQuery',
    strictQuery: true,
    errors: [502, 503],
    description:
      'Read-only server-authenticated discovery. Omitted credential defaults to dedicated. No automatic credential fallback; no organization or collaborator repositories. Rejects duplicate or unsupported query fields and incomplete upstream results.',
  },
  {
    method: 'get',
    path: '/workspaces/branches',
    id: 'listWorkspaceBranches',
    summary: 'Discover supported repository branches',
    response: 'WorkspaceBranches',
    query: 'BranchDiscoveryQuery',
    strictQuery: true,
    errors: [502, 503],
    description:
      'Requires explicit credential and private user-owned repository. Returns actual supported branches, never an automatically selected default. Duplicate query fields are rejected.',
  },
  {
    method: 'get',
    path: '/workspaces/files',
    id: 'listWorkspaceFiles',
    summary: 'Discover candidate JSON state paths',
    response: 'WorkspaceFiles',
    query: 'FileDiscoveryQuery',
    strictQuery: true,
    errors: [502, 503],
    description:
      'Requires explicit credential, private user-owned repository, and existing branch. Returns safe regular JSON paths, not file contents or verified portable states. Duplicate query fields are rejected.',
  },
  {
    method: 'patch',
    path: '/workspaces/{id}',
    id: 'updateWorkspace',
    summary: 'Rename or connect a workspace',
    body: 'UpdateWorkspaceInput',
    response: 'Workspace',
    errors: [404, 409, 503],
    description:
      'Supports local-to-cloud connection only. Existing cloud targets and credentials cannot change; validation depends on the stored workspace. An empty patch is accepted.',
  },
  {
    method: 'get',
    path: '/workspaces/{id}/removal-preview',
    id: 'previewWorkspaceRemoval',
    summary: 'Preview local workspace removal',
    response: 'WorkspaceRemovalPreview',
    strictQuery: true,
    errors: [404, 409, 503],
    description:
      'Local-only impact and revision fingerprint; no remote request. Review before confirming removal.',
  },
  {
    method: 'delete',
    path: '/workspaces/{id}',
    id: 'removeWorkspace',
    summary: 'Remove a reviewed local workspace',
    body: 'RemoveWorkspaceInput',
    query: 'ConfirmDeletionQuery',
    strictQuery: true,
    response: 'WorkspaceList',
    errors: [404, 409, 503],
    description:
      'Requires the literal query string confirm=true and a current reviewed revision. Deletes local data and backups, never GitHub files. The final workspace may be removed. Do not retry timed-out writes blindly.',
  },
];

const domain: Route[] = [
  {
    method: 'get',
    path: '/state',
    id: 'getState',
    summary: 'Read the graph with derived completion',
    response: 'Snapshot',
  },
  {
    method: 'post',
    path: '/tasks',
    id: 'createTask',
    summary: 'Create a task',
    body: 'CreateTaskInput',
    response: 'TaskView',
    status: 201,
    errors: [409],
  },
  {
    method: 'patch',
    path: '/tasks/{id}',
    id: 'updateTask',
    summary: 'Update task text or PR gate',
    body: 'UpdateTaskInput',
    response: 'TaskView',
    description:
      'At least one field is required. PR URL validity and permitted gate changes depend on task kind; null removes only a manual gate.',
  },
  {
    method: 'post',
    path: '/tasks/{id}/connections',
    id: 'connectTask',
    summary: 'Connect a task or insert it into an edge',
    body: 'ConnectTaskInput',
    response: 'TaskView',
    status: 201,
    errors: [409],
    description:
      'Exactly one existing taskId or new task is required. Optional dependencyId splits only the selected matching edge. Creation and all edge changes are atomic; graph cycles and mismatched edges are rejected.',
  },
  {
    method: 'post',
    path: '/tasks/{id}/done',
    id: 'setTaskDone',
    summary: 'Set manual work completion',
    body: 'SetDoneInput',
    response: 'TaskView',
    description:
      'Manual tasks only. This does not bypass PR gates or prerequisites; completion remains server-derived.',
  },
  {
    method: 'get',
    path: '/tasks/{id}/deletion-preview',
    id: 'previewTaskDeletion',
    summary: 'Preview task deletion impact',
    response: 'DeletionPreview',
  },
  {
    method: 'delete',
    path: '/tasks/{id}',
    id: 'deleteTask',
    summary: 'Delete a reviewed task and owned descendants',
    query: 'ConfirmDeletionQuery',
    response: 'DeleteTaskResponse',
    description:
      'Requires literal query string confirm=true. Preview and authorize first; reference targets are not deleted solely because they are referenced. Unrelated query fields are ignored.',
  },
  {
    method: 'post',
    path: '/tags',
    id: 'createTag',
    summary: 'Create a workspace tag',
    body: 'CreateTagInput',
    response: 'Tag',
    status: 201,
  },
  {
    method: 'patch',
    path: '/tags/{id}',
    id: 'updateTag',
    summary: 'Rename or recolor a workspace tag',
    body: 'UpdateTagInput',
    response: 'Tag',
    description: 'System tags cannot be changed.',
  },
  {
    method: 'get',
    path: '/tags/{id}/deletion-preview',
    id: 'previewTagDeletion',
    summary: 'Preview tag deletion impact',
    response: 'TagDeletionPreview',
    description:
      'Returns every task whose membership would be detached. System tags cannot be deleted.',
  },
  {
    method: 'delete',
    path: '/tags/{id}',
    id: 'deleteTag',
    summary: 'Delete a tag and detach its memberships',
    query: 'ConfirmDeletionQuery',
    response: 'DeleteTagResponse',
    description: 'Requires literal query string confirm=true. System tags cannot be deleted.',
  },
  {
    method: 'put',
    path: '/tasks/{taskId}/tags',
    id: 'replaceTaskTags',
    summary: 'Replace a task custom tag set',
    body: 'SetTaskTagsInput',
    response: 'TaskView',
    description:
      'Replaces up to three custom tags while preserving Favorites. The body cannot contain favorites.',
  },
  {
    method: 'put',
    path: '/tasks/{taskId}/tags/{tagId}',
    id: 'attachTaskTag',
    summary: 'Attach one tag to a task',
    body: 'EmptyBody',
    response: 'TaskView',
    description: 'Idempotent. Favorites does not count toward the three-custom-tag limit.',
  },
  {
    method: 'delete',
    path: '/tasks/{taskId}/tags/{tagId}',
    id: 'detachTaskTag',
    summary: 'Detach one tag from a task',
    response: 'TaskView',
    description: 'Idempotent.',
  },
  {
    method: 'post',
    path: '/dependencies',
    id: 'createDependency',
    summary: 'Add a prerequisite relationship',
    body: 'CreateDependencyInput',
    response: 'Dependency',
    status: 201,
    errors: [409],
  },
  {
    method: 'delete',
    path: '/dependencies/{id}',
    id: 'deleteDependency',
    summary: 'Remove a dependency by relationship ID',
    response: 'OkResponse',
  },
  {
    method: 'post',
    path: '/references',
    id: 'createReference',
    summary: 'Share a task with a container',
    body: 'CreateReferenceInput',
    response: 'TaskReference',
    status: 201,
    errors: [409],
  },
  {
    method: 'delete',
    path: '/references/{id}',
    id: 'deleteReference',
    summary: 'Unlink a reference without deleting its task',
    response: 'OkResponse',
  },
  {
    method: 'put',
    path: '/layout',
    id: 'saveLayout',
    summary: 'Save a container or root layout',
    body: 'Layout',
    response: 'Layout',
    description:
      'viewId is root or a container ID. Coordinates must be finite; node membership and duplicate positions are checked by the server.',
  },
  {
    method: 'put',
    path: '/preferences',
    id: 'saveWorkspacePreferences',
    summary: 'Save workspace UI preferences',
    body: 'WorkspacePreferences',
    response: 'WorkspacePreferences',
  },
  {
    method: 'get',
    path: '/github/status',
    id: 'getGithubStatus',
    summary: 'Read PR polling status',
    response: 'GithubStatus',
  },
  {
    method: 'get',
    path: '/github/prs',
    id: 'listGithubPrs',
    summary: 'Read cached authored open pull requests',
    response: 'GithubPrList',
  },
  {
    method: 'post',
    path: '/github/sync',
    id: 'syncGithub',
    summary: 'Poll GitHub PR state immediately',
    body: 'EmptyBody',
    optionalBody: true,
    response: 'GithubStatus',
    description:
      'Accepts {} with application/json or an absent body without Content-Type. A successful HTTP response does not guarantee GitHub success: inspect configured, syncing, and error. This is not workspace state sync.',
  },
  {
    method: 'get',
    path: '/sync/status',
    id: 'getSyncStatus',
    summary: 'Read local workspace sync status',
    response: 'SyncStatus',
    description: 'Reads local configuration and baseline state without remote requests.',
  },
  {
    method: 'post',
    path: '/sync/preview',
    id: 'previewSync',
    summary: 'Preview a merge or revert to origin',
    body: 'SyncPreviewInput',
    response: 'SyncPreview',
    errors: [409, 502],
    description:
      'Requires a JSON object ({} selects merge); revert forbids resolution. Inspect canApply, conflicts, validationError, and both change lists. Revert previews exact local replacement and never writes GitHub. Preview replaces any previous process-local preview.',
  },
  {
    method: 'post',
    path: '/sync/apply',
    id: 'applySync',
    summary: 'Apply a reviewed sync preview',
    body: 'SyncApplyInput',
    response: 'SyncStatus',
    errors: [409, 502],
    description:
      'Requires explicit true confirmation and a reviewed applicable single-use preview. Revalidates local and remote state. Never retry blindly after failure or timeout; a remote write may have committed. Revert discards local differences without writing GitHub.',
  },
];

const root = new URL('../', import.meta.url);
const output = new URL('openapi.json', root);
const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const content = (name: string) => ({ 'application/json': { schema: ref(name) } });

export function generateOpenApi(): OpenApiDocument {
  const generated = createGenerator({
    path: fileURLToPath(new URL('src/shared.ts', root)),
    type: '*',
    expose: 'export',
    jsDoc: 'extended',
    additionalProperties: false,
    skipTypeCheck: false,
  }).createSchema('*');
  // Only the reference namespace changes; draft-07 metadata is not embedded in OpenAPI 3.1.
  const schemas = JSON.parse(
    JSON.stringify(generated.definitions).replaceAll('#/definitions/', '#/components/schemas/'),
  ) as Record<string, Schema>;
  schemas.CreateTaskInput.allOf = [
    {
      if: { properties: { kind: { const: 'pr' } }, required: ['kind'] },
      then: { required: ['prUrl'] },
    },
    {
      if: { properties: { kind: { const: 'container' } }, required: ['kind'] },
      then: { not: { required: ['prUrl'] } },
    },
  ];
  schemas.ConnectTaskInput.oneOf = [{ required: ['taskId'] }, { required: ['task'] }];
  schemas.CreateWorkspaceInput.allOf = [
    {
      if: { properties: { type: { const: 'cloud' } }, required: ['type'] },
      then: { required: ['target'] },
    },
    {
      if: { properties: { type: { const: 'local' } }, required: ['type'] },
      then: { not: { anyOf: [{ required: ['target'] }, { required: ['credential'] }] } },
    },
  ];
  schemas.Workspace.allOf = [
    {
      if: { properties: { type: { const: 'local' } }, required: ['type'] },
      then: { properties: { target: { type: 'null' }, credential: { type: 'null' } } },
      else: {
        properties: { target: { not: { type: 'null' } }, credential: { not: { type: 'null' } } },
      },
    },
  ];
  schemas.SyncPreviewInput.allOf = [
    {
      if: { properties: { mode: { const: 'revert' } }, required: ['mode'] },
      then: { not: { required: ['resolution'] } },
    },
  ];

  const document: OpenApiDocument = {
    openapi: '3.1.0',
    info: {
      title: 'FoggyBrain HTTP API',
      version: '1.0.0',
      description:
        'Authoritative HTTP shapes, routes, and transport rules, generated from src/shared.ts and scripts/openapi.ts. See CONTRACT.md for domain semantics. Trusted local tool, not an authenticated multi-user service: bind to loopback and do not expose publicly. Host/Origin and cross-site request checks are enforced, but are not user authentication. Credentials stay on the server: dedicated sync uses only FOGGY_SYNC_TOKEN; explicit github mode reuses GH_TOKEN, GITHUB_TOKEN, or gh auth token. Cloud sync requires Contents read/write on the configured private repository; PR polling credentials should be read-only. JSON requests are limited to 256kb. POST/PATCH/PUT require application/json except an absent GitHub sync body. All errors are JSON; malformed JSON/URLs return 400, rejected local request headers 403, oversized bodies 413, unsupported media type/encoding 415, and unexpected failures 500.',
    },
    servers: [{ url: 'http://127.0.0.1:4173' }],
    externalDocs: {
      description: 'Completion, ownership, credential, and sync semantics',
      url: './CONTRACT.md',
    },
    paths: {},
    components: { schemas },
  };
  const errorDescriptions: Record<number, string> = {
    400: 'Malformed JSON/URL, unsupported fields, invalid input, or missing confirmation.',
    403: 'Host, Origin, or cross-site request rejected by the local-tool boundary.',
    404: 'Route, workspace, task, or relationship not found; no default workspace exists.',
    409: 'Graph conflict, workspace limit, active sync, or stale preview; review state before retrying.',
    413: 'JSON body exceeds the 256kb limit.',
    415: 'Unsupported Content-Type, JSON charset, or content encoding.',
    500: 'Unexpected internal server error; details are not exposed.',
    502: 'Sanitized upstream GitHub failure.',
    503: 'Selected credentials/configuration unavailable or workspace service stopped.',
  };
  const mounts = [
    { prefix: '/api', suffix: '', routes: management, scoped: false, domain: false },
    { prefix: '/api', suffix: '', routes: domain, scoped: false, domain: true },
    {
      prefix: '/api/workspaces/{workspaceId}',
      suffix: 'Scoped',
      routes: domain,
      scoped: true,
      domain: true,
    },
  ];
  for (const mount of mounts) {
    for (const route of mount.routes) {
      const path = `${mount.prefix}${route.path}`;
      const parameters: Parameter[] = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
        name: match[1],
        in: 'path',
        required: true,
        schema: { type: 'string' },
        description:
          match[1] === 'workspaceId'
            ? 'Server-returned workspace ID. Unknown IDs fail without fallback.'
            : 'Server-returned resource ID; relationship removal uses the relationship ID, not a task ID.',
      }));
      if (route.query) {
        const query = schemas[route.query];
        for (const [name, schema] of Object.entries(query.properties ?? {})) {
          parameters.push({
            name,
            in: 'query',
            required: query.required?.includes(name) ?? false,
            schema,
            ...(schema.description ? { description: schema.description } : {}),
          });
        }
      }
      const responses: Record<string, Response> = {
        [route.status ?? 200]: {
          description: route.status === 201 ? 'Created.' : 'Success.',
          headers: {
            'Cache-Control': {
              description: 'API responses are not cached, including credential-backed discovery.',
              schema: { type: 'string', const: 'no-store' },
            },
          },
          content: content(route.response),
        },
      };
      for (const status of new Set([
        400,
        403,
        413,
        415,
        500,
        ...(mount.domain ? [404, 409, 503] : []),
        ...(route.errors ?? []),
      ])) {
        responses[status] = {
          description: errorDescriptions[status],
          content: content('ErrorResponse'),
        };
      }
      const operation: Operation = {
        operationId: `${route.id}${mount.suffix}`,
        summary: route.summary,
        description: [
          route.description,
          mount.domain
            ? mount.scoped
              ? 'Uses only the explicitly selected workspace.'
              : 'Uses the persisted default workspace; returns 404 when none exists.'
            : 'Unscoped management endpoint.',
          'See CONTRACT.md for state-dependent validation and semantics.',
        ]
          .filter(Boolean)
          .join(' '),
        parameters,
        responses,
        'x-query-policy': route.strictQuery ? 'declared-only' : 'undeclared-ignored',
        ...(route.body
          ? { requestBody: { required: !route.optionalBody, content: content(route.body) } }
          : {}),
      };
      (document.paths[path] ??= {})[route.method] = operation;
    }
  }
  return document;
}

export async function validateOpenApi(document: OpenApiDocument): Promise<void> {
  // The parser dereferences in place; keep the generator's reference-based output intact.
  await SwaggerParser.validate(JSON.parse(JSON.stringify(document)), {
    resolve: { external: false, file: false, http: false },
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--check'))
    throw new Error('Usage: tsx scripts/openapi.ts [--check]');
  const document = generateOpenApi();
  await validateOpenApi(document);
  const serialized = await format(JSON.stringify(document), { parser: 'json', printWidth: 100 });
  if (args.includes('--check')) {
    if ((await readFile(output, 'utf8')) !== serialized) {
      throw new Error('openapi.json is stale. Run pnpm openapi:generate.');
    }
  } else {
    await writeFile(output, serialized);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'OpenAPI generation failed.');
    process.exitCode = 1;
  });
}
