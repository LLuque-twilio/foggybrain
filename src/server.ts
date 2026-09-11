import express, { type ErrorRequestHandler, type Request } from 'express';
import { config as loadDotenv } from 'dotenv';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyConfigFile, configFilePath, readConfigFile, readTokenFromGhCli } from './config.js';
import { Store, DomainError } from './core.js';
import { GithubPoller, parsePollInterval } from './github.js';
import { readSyncConfig, StateSync } from './sync.js';
import type {
  CreateTagInput,
  CreateTaskInput,
  Layout,
  SetTaskTagsInput,
  UpdateTagInput,
  UpdateTaskInput,
  WorkspacePreferences,
} from './shared.js';
import { WorkspaceManager } from './workspaces.js';

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const rawPort = env.FOGGY_PORT ?? '4173';
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('FOGGY_PORT must be an integer between 1 and 65535.');
  }
  if (env.FOGGY_DATA_DIR !== undefined && !env.FOGGY_DATA_DIR.trim())
    throw new Error('FOGGY_DATA_DIR must not be empty.');
  const dataDir = resolve(env.FOGGY_DATA_DIR ?? join(homedir(), '.local', 'share', 'foggybrain'));
  return {
    port,
    dataDir,
    databasePath: join(dataDir, 'foggybrain.sqlite'),
    token: env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim() || undefined,
    intervalMs: parsePollInterval(env.FOGGY_POLL_INTERVAL_MS),
    syncTarget: readSyncConfig(env),
    syncToken: env.FOGGY_SYNC_TOKEN,
  };
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HttpError(400, 'Expected a JSON object.');
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new HttpError(400, 'Request contains unsupported fields.');
  return value as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, key: string, optional = false): void {
  if (optional && !(key in body)) return;
  if (typeof body[key] !== 'string') throw new HttpError(400, `${key} must be a string.`);
}

function id(req: Request): string {
  if (typeof req.params.id !== 'string') throw new HttpError(400, 'Invalid ID.');
  return req.params.id;
}

function param(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string') throw new HttpError(400, 'Invalid ID.');
  return value;
}

function stringArrayField(body: Record<string, unknown>, key: string, optional = false): void {
  if (optional && !(key in body)) return;
  if (
    !Array.isArray(body[key]) ||
    (body[key] as unknown[]).some((value) => typeof value !== 'string')
  )
    throw new HttpError(400, `${key} must be an array of strings.`);
}

function localHost(host: string | undefined, port: number): boolean {
  const match = /^(localhost|127\.0\.0\.1)(?::([0-9]+))?$/i.exec(host ?? '');
  return Boolean(match && [port, 5173].includes(Number(match[2] ?? 80)));
}

function localOrigin(origin: string, port: number): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && url.origin === origin && localHost(url.host, port);
  } catch {
    return false;
  }
}

export interface AppOptions {
  port?: number;
  webRoot?: string;
  sync?: Pick<StateSync, 'getStatus' | 'preview' | 'apply'>;
  workspaces?: WorkspaceManager;
}

export function createApp(
  store: Store | null,
  github: Pick<GithubPoller, 'getStatus' | 'getPrs' | 'sync'> | null,
  options: AppOptions = {},
) {
  const app = express();
  const port = options.port ?? 4173;
  app.disable('x-powered-by');
  app.set('query parser', 'simple');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    const origin = req.headers.origin;
    if (
      !localHost(req.headers.host, port) ||
      (origin !== undefined && !localOrigin(origin, port)) ||
      (!origin && req.headers['sec-fetch-site'] === 'cross-site')
    ) {
      next(new HttpError(403, 'Only requests from the local Foggybrain UI or CLI are allowed.'));
      return;
    }
    next();
  });
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', (req, _res, next) => {
    const emptySync =
      req.method === 'POST' &&
      /^(?:\/workspaces\/[^/]+)?\/github\/sync$/.test(req.path) &&
      !req.headers['content-type'] &&
      !req.headers['transfer-encoding'] &&
      (!req.headers['content-length'] || req.headers['content-length'] === '0');
    if (
      ['POST', 'PATCH', 'PUT'].includes(req.method) &&
      !emptySync &&
      !req.is('application/json')
    ) {
      next(new HttpError(415, 'Content-Type must be application/json.'));
      return;
    }
    next();
  });
  app.use('/api', express.json({ limit: '256kb', strict: true }));
  app.get('/api/health', (_req, res) => res.json({ ok: true, pid: process.pid }));

  if (options.workspaces) {
    const manager = options.workspaces;
    const routers = new WeakMap<StateSync, ReturnType<typeof domainRoutes>>();
    const routes = (workspaceId: string) => {
      const runtime = manager.get(workspaceId);
      let router = routers.get(runtime.sync);
      if (!router) {
        router = domainRoutes(runtime.store, runtime.github, runtime.sync);
        routers.set(runtime.sync, router);
      }
      return router;
    };
    app.get('/api/workspaces', (_req, res) => res.json(manager.list()));
    app.get('/api/workspaces/repositories', async (req, res) => {
      if (Object.keys(req.query).some((key) => key !== 'credential'))
        throw new HttpError(400, 'Repository discovery contains unsupported query fields.');
      res.json(await manager.repositories(req.query.credential));
    });
    for (const kind of ['branches', 'files']) {
      app.get(`/api/workspaces/${kind}`, async (req, res) => {
        const fields = kind === 'files' ? ['credential', 'repo', 'branch'] : ['credential', 'repo'];
        if (
          Object.keys(req.query).some((key) => !fields.includes(key)) ||
          fields.some((key) => typeof req.query[key] !== 'string')
        )
          throw new HttpError(
            400,
            'Discovery requires explicit credential, repo, and (for files) branch query fields.',
          );
        res.json(
          await manager.repositoryEntries(req.query.credential, req.query.repo, req.query.branch),
        );
      });
    }
    app.post('/api/workspaces', (req, res) => res.status(201).json(manager.create(req.body)));
    app.patch('/api/workspaces/:id', (req, res) => res.json(manager.update(id(req), req.body)));
    app.get('/api/workspaces/:id/removal-preview', (req, res) => {
      if (Object.keys(req.query).length) throw new HttpError(400, 'Unsupported query fields.');
      res.json(manager.removalPreview(id(req)));
    });
    app.delete('/api/workspaces/:id', async (req, res) => {
      if (req.query.confirm !== 'true' || Object.keys(req.query).some((key) => key !== 'confirm'))
        throw new HttpError(400, 'Workspace removal requires only confirm=true.');
      if (!req.is('application/json'))
        throw new HttpError(415, 'Content-Type must be application/json.');
      res.json(await manager.remove(id(req), req.body));
    });
    app.use('/api/workspaces/:workspaceId', (req, res, next) => {
      routes(req.params.workspaceId)(req, res, next);
    });
    app.use('/api', (req, res, next) => {
      const workspaceId = manager.list().defaultWorkspaceId;
      if (workspaceId === null)
        throw new HttpError(404, 'No workspace selected. Add or connect a workspace.');
      routes(workspaceId)(req, res, next);
    });
  } else {
    if (!store || !github)
      throw new Error('A workspace manager or store and GitHub service is required.');
    const sync = options.sync ?? new StateSync(store, { target: null });
    app.use('/api/workspaces/default', domainRoutes(store, github, sync));
    app.use('/api', domainRoutes(store, github, sync));
  }
  app.use('/api', (_req, _res, next) => {
    next(new HttpError(404, 'API route not found.'));
  });

  const webRoot =
    options.webRoot ??
    fileURLToPath(
      new URL(import.meta.url.endsWith('.ts') ? '../dist/web/' : '../web/', import.meta.url),
    );
  app.use(express.static(webRoot, { dotfiles: 'deny' }));
  app.get('/', (_req, res, next) => {
    res.sendFile(join(webRoot, 'index.html'), (error) => {
      if (error) next(new HttpError(404, 'Web build not found. Run pnpm build, or use pnpm dev.'));
    });
  });
  app.use((_req, _res, next) => {
    next(new HttpError(404, 'Not found.'));
  });
  const errors: ErrorRequestHandler = (error: unknown, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    if (error instanceof HttpError || error instanceof DomainError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    const type = error && typeof error === 'object' && 'type' in error ? error.type : null;
    if (type === 'entity.too.large')
      res.status(413).json({ error: 'JSON body exceeds the 256kb limit.' });
    else if (type === 'entity.parse.failed')
      res.status(400).json({ error: 'Malformed JSON body.' });
    else if (type === 'charset.unsupported' || type === 'encoding.unsupported')
      res.status(415).json({ error: 'Unsupported JSON encoding.' });
    else if (error instanceof URIError) res.status(400).json({ error: 'Malformed URL.' });
    else res.status(500).json({ error: 'Internal server error.' });
  };
  app.use(errors);
  return app;
}

function domainRoutes(
  store: Store,
  github: Pick<GithubPoller, 'getStatus' | 'getPrs' | 'sync'>,
  sync: Pick<StateSync, 'getStatus' | 'preview' | 'apply'>,
) {
  const app = express.Router();
  app.get('/state', (_req, res) => {
    res.json(store.snapshot());
  });
  app.post('/tasks', (req, res) => {
    const body = object(req.body, ['title', 'description', 'kind', 'parentId', 'prUrl', 'tagIds']);
    stringField(body, 'title');
    stringField(body, 'description', true);
    stringField(body, 'prUrl', true);
    if (!['container', 'manual', 'pr'].includes(body.kind as string))
      throw new HttpError(400, 'kind must be container, manual, or pr.');
    if ('parentId' in body && body.parentId !== null) stringField(body, 'parentId');
    stringArrayField(body, 'tagIds', true);
    res.status(201).json(store.createTask(body as unknown as CreateTaskInput));
  });
  app.patch('/tasks/:id', (req, res) => {
    const body = object(req.body, ['title', 'description', 'prUrl', 'tagIds']);
    for (const field of ['title', 'description']) stringField(body, field, true);
    if (body.prUrl !== null) stringField(body, 'prUrl', true);
    stringArrayField(body, 'tagIds', true);
    res.json(store.updateTask(id(req), body as UpdateTaskInput));
  });
  app.post('/tasks/:id/connections', (req, res) => {
    res.status(201).json(store.connectTask(id(req), req.body));
  });
  app.post('/tasks/:id/done', (req, res) => {
    const body = object(req.body, ['done']);
    if (typeof body.done !== 'boolean') throw new HttpError(400, 'done must be a boolean.');
    res.json(store.setDone(id(req), body.done));
  });
  app.get('/tasks/:id/deletion-preview', (req, res) => {
    res.json(store.previewDeletion(id(req)));
  });
  app.delete('/tasks/:id', (req, res) => {
    if (req.query.confirm !== 'true') throw new HttpError(400, 'Deletion requires confirm=true.');
    res.json({ deleted: store.deleteTask(id(req)) });
  });
  app.post('/tags', (req, res) => {
    const body = object(req.body, ['name', 'color']);
    stringField(body, 'name');
    stringField(body, 'color');
    res.status(201).json(store.createTag(body as unknown as CreateTagInput));
  });
  app.patch('/tags/:id', (req, res) => {
    const body = object(req.body, ['name', 'color']);
    stringField(body, 'name', true);
    stringField(body, 'color', true);
    res.json(store.updateTag(id(req), body as UpdateTagInput));
  });
  app.get('/tags/:id/deletion-preview', (req, res) => {
    res.json(store.previewTagDeletion(id(req)));
  });
  app.delete('/tags/:id', (req, res) => {
    if (req.query.confirm !== 'true') throw new HttpError(400, 'Deletion requires confirm=true.');
    res.json({ detachedTaskIds: store.deleteTag(id(req)) });
  });
  app.put('/tasks/:taskId/tags', (req, res) => {
    const body = object(req.body, ['tagIds']);
    stringArrayField(body, 'tagIds');
    res.json(
      store.replaceTaskTags(param(req, 'taskId'), (body as unknown as SetTaskTagsInput).tagIds),
    );
  });
  app.put('/tasks/:taskId/tags/:tagId', (req, res) => {
    object(req.body, []);
    res.json(store.attachTaskTag(param(req, 'taskId'), param(req, 'tagId')));
  });
  app.delete('/tasks/:taskId/tags/:tagId', (req, res) => {
    res.json(store.detachTaskTag(param(req, 'taskId'), param(req, 'tagId')));
  });
  app.post('/dependencies', (req, res) => {
    const body = object(req.body, ['prerequisiteId', 'dependentId']);
    stringField(body, 'prerequisiteId');
    stringField(body, 'dependentId');
    res
      .status(201)
      .json(store.addDependency(body.prerequisiteId as string, body.dependentId as string));
  });
  app.delete('/dependencies/:id', (req, res) => {
    store.removeDependency(id(req));
    res.json({ ok: true });
  });
  app.post('/references', (req, res) => {
    const body = object(req.body, ['containerId', 'taskId']);
    stringField(body, 'containerId');
    stringField(body, 'taskId');
    res.status(201).json(store.addReference(body.containerId as string, body.taskId as string));
  });
  app.delete('/references/:id', (req, res) => {
    store.removeReference(id(req));
    res.json({ ok: true });
  });
  app.put('/layout', (req, res) => {
    const body = object(req.body, ['viewId', 'mode', 'positions']);
    stringField(body, 'viewId');
    if (body.mode !== 'auto' && body.mode !== 'manual')
      throw new HttpError(400, 'mode must be auto or manual.');
    if (!Array.isArray(body.positions)) throw new HttpError(400, 'positions must be an array.');
    for (const value of body.positions) {
      const position = object(value, ['nodeId', 'x', 'y']);
      stringField(position, 'nodeId');
      if (
        typeof position.x !== 'number' ||
        !Number.isFinite(position.x) ||
        typeof position.y !== 'number' ||
        !Number.isFinite(position.y)
      ) {
        throw new HttpError(400, 'Layout coordinates must be finite numbers.');
      }
    }
    res.json(store.saveLayout(body as unknown as Layout));
  });
  app.put('/preferences', (req, res) => {
    const body = object(req.body, ['hideCompleted']);
    if (typeof body.hideCompleted !== 'boolean') {
      throw new HttpError(400, 'hideCompleted must be a boolean.');
    }
    res.json(store.savePreferences(body as unknown as WorkspacePreferences));
  });
  app.get('/github/status', (_req, res) => {
    res.json(github.getStatus());
  });
  app.get('/github/prs', (_req, res) => {
    res.json(github.getPrs());
  });
  app.post('/github/sync', async (req, res) => {
    if (req.body !== undefined) object(req.body, []);
    res.json(await github.sync());
  });
  app.get('/sync/status', (_req, res) => {
    res.json(sync.getStatus());
  });
  app.post('/sync/preview', async (req, res) => {
    const body = object(req.body, ['resolution', 'mode']);
    if ('mode' in body && body.mode !== 'merge' && body.mode !== 'revert')
      throw new HttpError(400, 'mode must be merge or revert.');
    if (body.mode === 'revert' && 'resolution' in body)
      throw new HttpError(400, 'Revert does not accept resolution.');
    if ('resolution' in body && body.resolution !== 'local' && body.resolution !== 'remote')
      throw new HttpError(400, 'resolution must be local or remote.');
    res.json(
      await sync.preview(body as { resolution?: 'local' | 'remote'; mode?: 'merge' | 'revert' }),
    );
  });
  app.post('/sync/apply', async (req, res) => {
    const body = object(req.body, ['previewId', 'confirm']);
    stringField(body, 'previewId');
    if (!(body.previewId as string).trim())
      throw new HttpError(400, 'previewId must not be empty.');
    if (body.confirm !== true) throw new HttpError(400, 'Sync apply requires confirm=true.');
    res.json(await sync.apply(body.previewId as string));
  });
  return app;
}

export interface EnvironmentOptions {
  configPath?: string;
  dotenvPaths?: string[];
  loadEnv?: boolean;
}

/** Resolution order: the process environment, then `config.json`, then `.env.local`/`.env`.
 * The config file is found by absolute path, so a globally installed server is configured the
 * same way wherever it was started from; the dotenv files remain relative to the checkout. */
export async function loadEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  options: EnvironmentOptions = {},
): Promise<void> {
  // `loadEnv: false` means this process reads nothing from disk, config file included. Tests
  // that isolate themselves by deleting a variable depend on it staying deleted.
  if (options.loadEnv === false) return;
  applyConfigFile(env, await readConfigFile(options.configPath ?? configFilePath(env)));
  const path = options.dotenvPaths ?? ['.env.local', '.env'];
  if (path.length > 0) loadDotenv({ path, quiet: true, processEnv: env });
}

export async function startServer(options: EnvironmentOptions = {}) {
  await loadEnvironment(process.env, options);
  const settings = readConfig();
  const token = settings.token ?? readTokenFromGhCli();
  const workspaces = new WorkspaceManager({
    dataDir: settings.dataDir,
    legacyTarget: settings.syncTarget,
    dedicatedToken: settings.syncToken,
    githubToken: token,
    intervalMs: settings.intervalMs,
  });
  try {
    for (const workspace of workspaces.list().workspaces) workspaces.get(workspace.id);
  } catch (error) {
    await workspaces.close();
    throw error;
  }
  const app = createApp(null, null, { port: settings.port, workspaces });
  const server = app.listen(settings.port, '127.0.0.1');
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
  } catch (error) {
    await workspaces.close();
    throw error;
  }
  workspaces.start();
  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    if (closing) return closing;
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    const connectionsClosed = new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    const forceClose = setTimeout(() => {
      server.closeAllConnections();
    }, 5000);
    forceClose.unref();
    closing = connectionsClosed
      .then(() => workspaces.close())
      .then(() => undefined)
      .finally(() => {
        clearTimeout(forceClose);
      });
    return closing;
  };
  const onSignal = () => {
    void close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  console.log(`Foggybrain is listening at http://127.0.0.1:${settings.port}`);
  return { app, server, workspaces, close };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void startServer().catch(() => {
    console.error(
      'Foggybrain could not start. Check the port, data directory, and environment configuration.',
    );
    process.exitCode = 1;
  });
}
