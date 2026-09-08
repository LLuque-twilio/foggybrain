import express, { type ErrorRequestHandler, type Request } from 'express';
import { config as loadDotenv } from 'dotenv';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store, DomainError } from './core.js';
import { GithubPoller, parsePollInterval } from './github.js';
import type { CreateTaskInput, Layout, UpdateTaskInput } from './shared.js';

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
}

export function createApp(
  store: Store,
  github: Pick<GithubPoller, 'getStatus' | 'getPrs' | 'sync'>,
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
      req.path === '/github/sync' &&
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

  app.get('/api/state', (_req, res) => {
    res.json(store.snapshot());
  });
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });
  app.post('/api/tasks', (req, res) => {
    const body = object(req.body, ['title', 'description', 'kind', 'parentId', 'prUrl']);
    stringField(body, 'title');
    stringField(body, 'description', true);
    stringField(body, 'prUrl', true);
    if (!['container', 'manual', 'pr'].includes(body.kind as string))
      throw new HttpError(400, 'kind must be container, manual, or pr.');
    if ('parentId' in body && body.parentId !== null) stringField(body, 'parentId');
    res.status(201).json(store.createTask(body as unknown as CreateTaskInput));
  });
  app.patch('/api/tasks/:id', (req, res) => {
    const body = object(req.body, ['title', 'description', 'prUrl']);
    for (const field of ['title', 'description', 'prUrl']) stringField(body, field, true);
    res.json(store.updateTask(id(req), body as UpdateTaskInput));
  });
  app.post('/api/tasks/:id/done', (req, res) => {
    const body = object(req.body, ['done']);
    if (typeof body.done !== 'boolean') throw new HttpError(400, 'done must be a boolean.');
    res.json(store.setDone(id(req), body.done));
  });
  app.get('/api/tasks/:id/deletion-preview', (req, res) => {
    res.json(store.previewDeletion(id(req)));
  });
  app.delete('/api/tasks/:id', (req, res) => {
    if (req.query.confirm !== 'true') throw new HttpError(400, 'Deletion requires confirm=true.');
    res.json({ deleted: store.deleteTask(id(req)) });
  });
  app.post('/api/dependencies', (req, res) => {
    const body = object(req.body, ['prerequisiteId', 'dependentId']);
    stringField(body, 'prerequisiteId');
    stringField(body, 'dependentId');
    res
      .status(201)
      .json(store.addDependency(body.prerequisiteId as string, body.dependentId as string));
  });
  app.delete('/api/dependencies/:id', (req, res) => {
    store.removeDependency(id(req));
    res.json({ ok: true });
  });
  app.post('/api/references', (req, res) => {
    const body = object(req.body, ['containerId', 'taskId']);
    stringField(body, 'containerId');
    stringField(body, 'taskId');
    res.status(201).json(store.addReference(body.containerId as string, body.taskId as string));
  });
  app.delete('/api/references/:id', (req, res) => {
    store.removeReference(id(req));
    res.json({ ok: true });
  });
  app.put('/api/layout', (req, res) => {
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
  app.get('/api/github/status', (_req, res) => {
    res.json(github.getStatus());
  });
  app.get('/api/github/prs', (_req, res) => {
    res.json(github.getPrs());
  });
  app.post('/api/github/sync', async (req, res) => {
    if (req.body !== undefined) object(req.body, []);
    res.json(await github.sync());
  });
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

function readTokenFromGhCli(): string | undefined {
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function startServer() {
  loadDotenv({ quiet: true });
  const settings = readConfig();
  const token = settings.token ?? readTokenFromGhCli();
  mkdirSync(settings.dataDir, { recursive: true, mode: 0o700 });
  const store = new Store(settings.databasePath);
  const github = new GithubPoller(store, {
    token,
    intervalMs: settings.intervalMs,
  });
  const app = createApp(store, github, { port: settings.port });
  const server = app.listen(settings.port, '127.0.0.1');
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
  } catch (error) {
    store.close();
    throw error;
  }
  github.start();
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
    closing = Promise.all([github.stop(), connectionsClosed])
      .then(() => undefined)
      .finally(() => {
        clearTimeout(forceClose);
        store.close();
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
  return { app, server, store, github, close };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void startServer().catch(() => {
    console.error(
      'Foggybrain could not start. Check the port, data directory, and environment configuration.',
    );
    process.exitCode = 1;
  });
}
