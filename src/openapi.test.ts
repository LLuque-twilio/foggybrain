import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import ts from 'typescript';
import {
  generateOpenApi,
  validateOpenApi,
  type Operation,
  type Schema,
} from '../scripts/openapi.js';
import { createApp } from './server.js';
import { WorkspaceManager } from './workspaces.js';
import type { GithubPr, SyncPreview, SyncPreviewInput, SyncStatus, SyncTarget } from './shared.js';

const document = generateOpenApi();
const operations = Object.entries(document.paths).flatMap(([path, methods]) =>
  Object.entries(methods).map(([method, operation]) => ({ path, method, operation })),
);
const ajv = new Ajv2020({ strict: false, allErrors: true });
const validators = new Map<Schema, ReturnType<typeof ajv.compile>>();
function conforms(schema: Schema, value: unknown): boolean {
  let validate = validators.get(schema);
  if (!validate) {
    validate = ajv.compile({ ...schema, components: document.components });
    validators.set(schema, validate);
  }
  return Boolean(validate(value));
}

test('generated OpenAPI matches the checked-in document and passes SwaggerParser', async () => {
  assert.deepEqual(
    document,
    JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8')),
  );
  await validateOpenApi(document);
  assert.equal(operations.length, 59);
  assert.equal(new Set(operations.map(({ operation }) => operation.operationId)).size, 59);
});

test('OpenAPI inventory matches independently parsed Express registrations and domain mounts', () => {
  const source = ts.createSourceFile(
    'server.ts',
    readFileSync(new URL('./server.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const direct: string[] = [];
  const domain: string[] = [];
  const mounts = new Set<string>();
  const normalize = (path: string) => path.replace(/:([A-Za-z]+)/g, '{$1}');
  function literal(node: ts.Node, bindings: Map<string, string>): string {
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isIdentifier(node) && bindings.has(node.text)) return bindings.get(node.text)!;
    if (ts.isTemplateExpression(node))
      return (
        node.head.text +
        node.templateSpans
          .map((span) => literal(span.expression, bindings) + span.literal.text)
          .join('')
      );
    assert.fail(`Unsupported dynamic route: ${node.getText(source)}`);
  }
  function containsDispatch(node: ts.Node): boolean {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ['routes', 'domainRoutes'].includes(node.expression.text)
    )
      return true;
    return ts.forEachChild(node, (child) => containsDispatch(child) || undefined) ?? false;
  }
  function visit(node: ts.Node, inDomain = false, bindings = new Map<string, string>()): void {
    if (ts.isFunctionDeclaration(node)) inDomain = node.name?.text === 'domainRoutes';
    if (ts.isForOfStatement(node)) {
      assert.ok(
        ts.isArrayLiteralExpression(node.expression),
        'Route loops must have a literal inventory',
      );
      assert.ok(ts.isVariableDeclarationList(node.initializer));
      const name = node.initializer.declarations[0].name;
      assert.ok(ts.isIdentifier(name));
      for (const entry of node.expression.elements)
        visit(
          node.statement,
          inDomain,
          new Map([...bindings, [name.text, literal(entry, bindings)]]),
        );
      return;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(source) === 'app'
    ) {
      const method = node.expression.name.text;
      if (['get', 'post', 'patch', 'put', 'delete', 'head', 'options', 'all'].includes(method)) {
        const path = literal(node.arguments[0], bindings);
        if (inDomain || path.startsWith('/api'))
          (inDomain ? domain : direct).push(`${method} ${normalize(path)}`);
      } else if (method === 'use' && node.arguments.slice(1).some(containsDispatch)) {
        const path = literal(node.arguments[0], bindings);
        mounts.add(normalize(path));
      } else {
        assert.ok(
          ['use', 'set', 'disable'].includes(method),
          `Unsupported Express registration: ${node.getText(source)}`,
        );
      }
      return;
    }
    ts.forEachChild(node, (child) => visit(child, inDomain, bindings));
  }
  for (const statement of source.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      ['createApp', 'domainRoutes'].includes(statement.name?.text ?? '')
    )
      visit(statement);
  }
  assert.deepEqual([...mounts].sort(), [
    '/api',
    '/api/workspaces/default',
    '/api/workspaces/{workspaceId}',
  ]);
  const inventory = [
    ...direct,
    ...[...mounts]
      .filter((mount) => mount !== '/api/workspaces/default')
      .flatMap((mount) => domain.map((route) => route.replace(' /', ` ${mount}/`))),
  ];
  assert.equal(new Set(inventory).size, inventory.length, 'Duplicate route registration');
  assert.deepEqual(
    inventory.sort(),
    operations.map(({ path, method }) => `${method} ${path}`).sort(),
  );
});

const target: SyncTarget = { repo: 'owner/state', branch: 'main', path: 'state.json' };
async function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'foggy-openapi-'));
  const manager = new WorkspaceManager({
    dataDir,
    dedicatedToken: 'test-only-token',
    fetch: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, 'https://api.github.com');
      assert.equal(init?.method ?? 'GET', 'GET', 'No GitHub writes');
      const repo = {
        id: 2,
        name: 'state',
        full_name: 'owner/state',
        private: true,
        default_branch: 'main',
        owner: { id: 1, login: 'owner', type: 'User' },
      };
      switch (url.pathname) {
        case '/user':
          return Response.json({ id: 1, login: 'owner' });
        case '/user/repos':
          return Response.json([repo]);
        case '/repos/owner/state':
          return Response.json(repo);
        case '/repos/owner/state/branches':
          return Response.json([{ name: 'main' }]);
        case '/repos/owner/state/branches/main':
          return Response.json({ name: 'main', commit: { sha: 'a'.repeat(40) } });
        case `/repos/owner/state/git/trees/${'a'.repeat(40)}`:
          return Response.json({
            truncated: false,
            tree: [{ path: 'state.json', type: 'blob', mode: '100644' }],
          });
        default:
          assert.fail(`Unexpected GitHub request: ${url.pathname}`);
      }
    },
  });
  const server = createApp(null, null, { workspaces: manager }).listen(0, '127.0.0.1');
  t.after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await manager.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  const covered = new Set<string>();
  async function call(
    method: string,
    path: string,
    status: number,
    body?: unknown,
    valid = true,
    raw?: string,
  ) {
    const pathname = path.split('?')[0];
    const entry = operations.find(
      (entry) =>
        entry.method === method.toLowerCase() &&
        new RegExp(`^${entry.path.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(pathname),
    );
    assert.ok(entry, `${method} ${path} is documented`);
    const operation: Operation = entry.operation;
    if (body !== undefined) {
      assert.ok(operation.requestBody);
      assert.equal(
        conforms(operation.requestBody.content['application/json'].schema, body),
        valid,
        `${operation.operationId} request: ${JSON.stringify(body)}`,
      );
    } else if (valid && raw === undefined)
      assert.ok(!operation.requestBody?.required, `${operation.operationId} requires a body`);
    if (valid && status < 300) {
      const query = new URLSearchParams(path.split('?')[1]);
      for (const parameter of operation.parameters.filter(
        (parameter) => parameter.in === 'query',
      )) {
        if (parameter.required) assert.ok(query.has(parameter.name));
        for (const value of query.getAll(parameter.name))
          assert.ok(conforms(parameter.schema, value));
      }
    }
    const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    return new Promise<any>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method,
          path,
          agent: false,
          headers: {
            Host: '127.0.0.1:4173',
            ...(payload === undefined
              ? {}
              : {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(payload),
                }),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('error', reject);
          res.on('end', () => {
            try {
              const text = Buffer.concat(chunks).toString();
              assert.equal(res.statusCode, status, `${operation.operationId}: ${text}`);
              assert.match(res.headers['content-type'] ?? '', /^application\/json\b/);
              assert.equal(res.headers['cache-control'], 'no-store');
              const response = operation.responses[status];
              assert.ok(response, `${operation.operationId} documents ${status}`);
              const value: unknown = JSON.parse(text);
              const schema = response.content['application/json'].schema;
              assert.ok(
                conforms(schema, value),
                `${operation.operationId} response: ${ajv.errorsText(validators.get(schema)?.errors)}; ${text}`,
              );
              if (status < 300) covered.add(operation.operationId);
              resolve(value);
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
  }
  return { manager, call, covered };
}

test('all operations conform over HTTP with real isolated workspace/domain stores', async (t) => {
  const { manager, call, covered } = await fixture(t);
  await call('GET', '/api/health', 200);
  const list = await call('GET', '/api/workspaces', 200);
  const local = await call('POST', '/api/workspaces', 201, { name: 'Isolated', type: 'local' });
  assert.equal(local.target, null);
  const cloud = await call('POST', '/api/workspaces', 201, {
    name: 'Cloud',
    type: 'cloud',
    target,
  });
  assert.equal(cloud.credential, 'dedicated');
  await call('PATCH', `/api/workspaces/${cloud.id}`, 200, {});
  await call('PATCH', `/api/workspaces/${local.id}`, 200, { name: 'Renamed' });
  assert.deepEqual((await call('GET', '/api/workspaces/repositories', 200)).repositories, [
    { id: 2, fullName: 'owner/state', defaultBranch: 'main' },
  ]);
  assert.deepEqual(
    await call('GET', '/api/workspaces/branches?credential=dedicated&repo=owner/state', 200),
    { branches: ['main'] },
  );
  assert.deepEqual(
    await call(
      'GET',
      '/api/workspaces/files?credential=dedicated&repo=owner/state&branch=main',
      200,
    ),
    { paths: ['state.json'] },
  );
  for (const [prefix, workspaceId] of [
    ['/api', list.defaultWorkspaceId],
    [`/api/workspaces/${local.id}`, local.id],
  ]) {
    const runtime = manager.get(workspaceId);
    const syncStatus: SyncStatus = {
      configured: true,
      target,
      lastSync: null,
      dirty: false,
      syncing: false,
    };
    let reviewed: string | undefined;
    t.mock.method(runtime.sync, 'getStatus', () => syncStatus);
    const previewMock = t.mock.method(
      runtime.sync,
      'preview',
      async (input: SyncPreviewInput): Promise<SyncPreview> => {
        reviewed = `preview-${workspaceId}`;
        return {
          mode: input.mode ?? 'merge',
          previewId: reviewed,
          target,
          localChanges: [],
          remoteChanges: [],
          conflicts: [],
          validationError: null,
          canApply: true,
          resolution: input.resolution ?? null,
        };
      },
    );
    const applyMock = t.mock.method(runtime.sync, 'apply', async (id: string) => {
      assert.equal(id, reviewed);
      reviewed = undefined;
      return syncStatus;
    });
    const task = await call('POST', `${prefix}/tasks`, 201, {
      title: 'Work',
      kind: 'manual',
      prUrl: 'https://github.com/owner/repo/pull/1',
    });
    const tag = await call('POST', `${prefix}/tags`, 201, {
      name: 'Release',
      color: '#123456',
    });
    assert.equal(
      (await call('PATCH', `${prefix}/tags/${tag.id}`, 200, { name: 'Shipping' })).name,
      'Shipping',
    );
    assert.deepEqual(
      (await call('PUT', `${prefix}/tasks/${task.id}/tags/${tag.id}`, 200, {})).tagIds,
      [tag.id],
    );
    assert.deepEqual(
      (await call('PUT', `${prefix}/tasks/${task.id}/tags`, 200, { tagIds: [tag.id] })).tagIds,
      [tag.id],
    );
    assert.deepEqual(
      (await call('DELETE', `${prefix}/tasks/${task.id}/tags/${tag.id}`, 200)).tagIds,
      [],
    );
    await call('PUT', `${prefix}/tasks/${task.id}/tags/${tag.id}`, 200, {});
    const tagDeletion = await call('GET', `${prefix}/tags/${tag.id}/deletion-preview`, 200);
    assert.deepEqual(
      tagDeletion.affectedTasks.map((entry: { id: string }) => entry.id),
      [task.id],
    );
    assert.deepEqual(await call('DELETE', `${prefix}/tags/${tag.id}?confirm=true`, 200), {
      detachedTaskIds: [task.id],
    });
    assert.equal(
      (await call('PATCH', `${prefix}/tasks/${task.id}`, 200, { prUrl: null })).prUrl,
      null,
    );
    assert.equal(
      (await call('POST', `${prefix}/tasks/${task.id}/done`, 200, { done: true })).status,
      'completed',
    );
    const container = await call('POST', `${prefix}/tasks`, 201, {
      title: 'Group',
      kind: 'container',
    });
    const next = await call('POST', `${prefix}/tasks/${task.id}/connections`, 201, {
      direction: 'dependent',
      task: { title: 'Next', kind: 'manual' },
    });
    const other = await call('POST', `${prefix}/tasks`, 201, { title: 'Other', kind: 'manual' });
    await call('POST', `${prefix}/tasks/${next.id}/connections`, 201, {
      direction: 'dependent',
      taskId: other.id,
    });
    const dependency = await call('POST', `${prefix}/dependencies`, 201, {
      prerequisiteId: task.id,
      dependentId: other.id,
    });
    const reference = await call('POST', `${prefix}/references`, 201, {
      containerId: container.id,
      taskId: task.id,
    });
    const layout = {
      viewId: 'root',
      mode: 'manual',
      positions: [{ nodeId: task.id, x: 12.5, y: -3 }],
    };
    assert.deepEqual(await call('PUT', `${prefix}/layout`, 200, layout), layout);
    const graph = await call('GET', `${prefix}/state`, 200);
    assert.ok(graph.tasks.some((entry: { id: string }) => entry.id === task.id));
    assert.equal(graph.references[0].id, reference.id);
    await call('DELETE', `${prefix}/references/${reference.id}`, 200);
    await call('DELETE', `${prefix}/dependencies/${dependency.id}`, 200);
    await call('GET', `${prefix}/github/status`, 200);
    await call('GET', `${prefix}/github/prs`, 200);
    assert.equal((await call('POST', `${prefix}/github/sync`, 200)).configured, false);
    await call('POST', `${prefix}/github/sync`, 200, {});
    await call('GET', `${prefix}/sync/status`, 200);
    const preview = await call('POST', `${prefix}/sync/preview`, 200, {});
    assert.equal(preview.mode, 'merge');
    assert.deepEqual(previewMock.mock.calls[0].arguments, [{}]);
    await call('POST', `${prefix}/sync/apply`, 200, {
      previewId: preview.previewId,
      confirm: true,
    });
    assert.equal(applyMock.mock.callCount(), 1);
    const deletion = await call('GET', `${prefix}/tasks/${container.id}/deletion-preview`, 200);
    assert.deepEqual(deletion.taskIds, [container.id]);
    assert.deepEqual(await call('DELETE', `${prefix}/tasks/${container.id}?confirm=true`, 200), {
      deleted: deletion.taskIds,
    });
    assert.equal(manager.get(workspaceId).store.snapshot().tasks.length, 3);
  }
  const removal = await call('GET', `/api/workspaces/${cloud.id}/removal-preview`, 200);
  const remaining = await call('DELETE', `/api/workspaces/${cloud.id}?confirm=true`, 200, {
    revision: removal.revision,
  });
  assert.ok(!remaining.workspaces.some((workspace: { id: string }) => workspace.id === cloud.id));
  assert.deepEqual(
    [...covered].sort(),
    operations.map(({ operation }) => operation.operationId).sort(),
  );
});

test('request boundaries agree with schemas; structural validity does not bypass domain checks', async (t) => {
  const { manager, call } = await fixture(t);
  const confirmation = document.components.schemas.ConfirmDeletionQuery;
  assert.ok(conforms(confirmation, { confirm: 'true' }));
  for (const confirm of [true, false, 'false', '1', ['true', 'true']])
    assert.equal(conforms(confirmation, { confirm }), false);
  const workspaceId = manager.list().defaultWorkspaceId!;
  for (const prefix of ['/api', `/api/workspaces/${workspaceId}`]) {
    const task = await call('POST', `${prefix}/tasks`, 201, { title: 'Anchor', kind: 'manual' });
    const invalid: [string, string, unknown][] = [
      ['POST', '/tasks', { title: 'PR', kind: 'pr' }],
      [
        'POST',
        '/tasks',
        { title: 'Group', kind: 'container', prUrl: 'https://github.com/owner/repo/pull/1' },
      ],
      ['POST', '/tasks', { title: 'Extra', kind: 'manual', manualDone: true }],
      ['POST', '/tasks', { title: '   ', kind: 'manual' }],
      ['PATCH', `/tasks/${task.id}`, {}],
      ['PATCH', `/tasks/${task.id}`, { title: 'X', extra: true }],
      ['POST', `/tasks/${task.id}/connections`, { direction: 'dependent' }],
      [
        'POST',
        `/tasks/${task.id}/connections`,
        { direction: 'dependent', taskId: task.id, task: { title: 'X', kind: 'manual' } },
      ],
      [
        'POST',
        `/tasks/${task.id}/connections`,
        { direction: 'dependent', task: { title: 'X', kind: 'pr' } },
      ],
      [
        'POST',
        `/tasks/${task.id}/connections`,
        { direction: 'dependent', task: { title: 'X', kind: 'manual', extra: 1 } },
      ],
      ['POST', `/tasks/${task.id}/done`, { done: 'true' }],
      ['POST', `/tasks/${task.id}/done`, { done: true, extra: 1 }],
      [
        'PUT',
        '/layout',
        { viewId: 'root', mode: 'manual', positions: [{ nodeId: task.id, x: 1, y: 2, extra: 1 }] },
      ],
      [
        'PUT',
        '/layout',
        { viewId: 'root', mode: 'manual', positions: [{ nodeId: task.id, x: '1', y: 2 }] },
      ],
      ['POST', '/github/sync', { extra: 1 }],
      ['POST', '/sync/preview', { mode: 'revert', resolution: 'remote' }],
      ['POST', '/sync/preview', { resolution: 'other' }],
      ['POST', '/sync/preview', { extra: 1 }],
      ['POST', '/sync/apply', { previewId: 'reviewed', confirm: 'true' }],
      ['POST', '/sync/apply', { previewId: 'reviewed', confirm: false }],
      ['POST', '/sync/apply', { previewId: 'reviewed' }],
      ['POST', '/sync/apply', { previewId: ' ', confirm: true }],
    ];
    for (const [method, path, body] of invalid) await call(method, prefix + path, 400, body, false);
    for (const query of ['', '?confirm=false', '?confirm=1', '?confirm=true&confirm=true'])
      await call('DELETE', `${prefix}/tasks/${task.id}${query}`, 400, undefined, false);
    await call('POST', `${prefix}/tasks`, 400, undefined, false, '{');
    await call('POST', `${prefix}/tasks`, 400, {
      title: 'Bad URL',
      kind: 'pr',
      prUrl: 'not-a-pr-url',
    });
    await call('PATCH', `${prefix}/tasks/missing`, 404, { title: 'Valid shape' });
    await call('POST', `${prefix}/tasks/${task.id}/connections`, 409, {
      direction: 'dependent',
      taskId: task.id,
    });
    await call('POST', `${prefix}/sync/preview`, 503, { mode: 'revert' });
    await call('POST', `${prefix}/tasks`, 201, {
      title: 'PR',
      kind: 'pr',
      prUrl: 'https://github.com/owner/repo/pull/2',
    });
  }
  for (const body of [
    { name: 'Local', type: 'local', target },
    { name: 'Local', type: 'local', credential: 'dedicated' },
    { name: 'Cloud', type: 'cloud' },
    { name: 'Cloud', type: 'cloud', target: { ...target, extra: 1 } },
    { name: 'Cloud', type: 'cloud', target, credential: 'other' },
    { name: 'Local', type: 'local', extra: 1 },
  ])
    await call('POST', '/api/workspaces', 400, body, false);
  await call('PATCH', `/api/workspaces/${workspaceId}`, 400, { type: 'cloud' });
  await call('PATCH', `/api/workspaces/${workspaceId}`, 200, {
    type: 'cloud',
    target,
    credential: 'dedicated',
  });
  const removal = await call('GET', `/api/workspaces/${workspaceId}/removal-preview`, 200);
  for (const query of [
    '',
    '?confirm=false',
    '?confirm=1',
    '?confirm=true&confirm=true',
    '?confirm=true&extra=1',
  ])
    await call(
      'DELETE',
      `/api/workspaces/${workspaceId}${query}`,
      400,
      { revision: removal.revision },
      true,
    );
  await call(
    'DELETE',
    `/api/workspaces/${workspaceId}?confirm=true`,
    400,
    { revision: removal.revision, confirm: true },
    false,
  );
  await call('DELETE', `/api/workspaces/${workspaceId}?confirm=true`, 409, { revision: 'stale' });
  for (const path of [
    '/repositories?credential=other',
    '/branches?credential=dedicated&repo=owner/state&repo=owner/state',
    '/files?credential=dedicated&repo=owner/state',
    '/repositories?extra=1',
  ])
    await call('GET', `/api/workspaces${path}`, 400, undefined, false);
});

test('held workspace removal and stopped service return documented lifecycle errors', async (t) => {
  const { manager, call } = await fixture(t);
  const workspaceId = manager.list().defaultWorkspaceId!;
  const path = `/api/workspaces/${workspaceId}`;
  const runtime = manager.get(workspaceId);
  const preview = await call('GET', `${path}/removal-preview`, 200);
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stopping = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const stop = runtime.github.stop.bind(runtime.github);
  t.mock.method(runtime.github, 'stop', async () => {
    entered();
    await held;
    await stop();
  });
  const removal = call('DELETE', `${path}?confirm=true`, 200, { revision: preview.revision });
  try {
    await Promise.race([
      stopping,
      removal.then(() => assert.fail('Removal did not wait for teardown')),
    ]);
    for (const endpoint of [
      '/state',
      '/github/status',
      '/github/prs',
      '/sync/status',
      '/removal-preview',
    ]) {
      await t.test(`GET ${endpoint} during removal`, async () => {
        const error = await call('GET', path + endpoint, 409);
        assert.match(error.error, /removal is in progress/i);
      });
    }
    await t.test('PATCH during removal', async () => {
      await call('PATCH', path, 409, { name: 'Cannot rename during removal' });
    });
    assert.equal(manager.list().defaultWorkspaceId, null);
    await call('GET', '/api/state', 404);
  } finally {
    release();
    await removal;
  }
  await call('GET', `${path}/removal-preview`, 404);
  await manager.close();
  const stopped = await call('GET', `${path}/removal-preview`, 503);
  assert.match(stopped.error, /service is stopped/i);
});

test('populated mocked PR cache and blocked sync preview conform over HTTP at both mounts', async (t) => {
  const { manager, call } = await fixture(t);
  const workspaceId = manager.list().defaultWorkspaceId!;
  const runtime = manager.get(workspaceId);
  const prs: GithubPr[] = [
    {
      url: 'https://github.com/owner/repo/pull/7',
      title: 'Review this change',
      number: 7,
      repository: 'owner/repo',
      state: 'open',
      draft: true,
      updatedAt: '2026-09-08T12:00:00.000Z',
    },
  ];
  const preview: SyncPreview = {
    mode: 'merge',
    previewId: 'blocked-preview',
    target,
    localChanges: [{ collection: 'tasks', id: 'task-a', title: 'Changed task', kind: 'updated' }],
    remoteChanges: [
      { collection: 'dependencies', id: 'dependency-a', kind: 'deleted' },
      { collection: 'references', id: 'reference-a', kind: 'added' },
    ],
    conflicts: [
      {
        path: 'tasks.task-a',
        base: null,
        local: [null, true, 3, 'text', { nested: [] }],
        remote: { arbitrary: { values: [false, null] } },
      },
    ],
    validationError: 'Merged graph contains a cycle',
    canApply: false,
    resolution: null,
  };
  t.mock.method(runtime.github, 'getPrs', () => prs);
  const mockPreview = t.mock.method(runtime.sync, 'preview', async () => preview);
  for (const prefix of ['/api', `/api/workspaces/${workspaceId}`]) {
    assert.deepEqual(await call('GET', `${prefix}/github/prs`, 200), prs);
    assert.deepEqual(await call('POST', `${prefix}/sync/preview`, 200, {}), preview);
  }
  assert.deepEqual(
    mockPreview.mock.calls.map((call) => call.arguments),
    [[{}], [{}]],
  );
});

test('workspace name UTF-16 length is runtime-owned for create and update', async (t) => {
  const { manager, call } = await fixture(t);
  const workspaceId = manager.list().defaultWorkspaceId!;
  const name = '\u{1F600}'.repeat(50);
  const tooLong = '\u{1F600}'.repeat(51);
  const created = await call('POST', '/api/workspaces', 201, { name, type: 'local' });
  assert.equal(created.name, name);
  assert.equal((await call('PATCH', `/api/workspaces/${workspaceId}`, 200, { name })).name, name);
  const before = manager.list();
  await call('POST', '/api/workspaces', 400, { name: tooLong, type: 'local' });
  await call('PATCH', `/api/workspaces/${workspaceId}`, 400, { name: tooLong });
  assert.deepEqual(manager.list(), before);
});
