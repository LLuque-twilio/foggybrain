import { DomainError, type Store } from './core.js';
import type { GithubPr, GithubStatus, PrState, TaskView, WorkspaceRepositories } from './shared.js';
import { safeSyncRef, type WorkspaceBranches, type WorkspaceFiles } from './shared.js';

const API_ROOT = 'https://api.github.com';
const NOT_CONFIGURED = 'GitHub token is not configured. Set GH_TOKEN or GITHUB_TOKEN.';
const RATE_LIMITED = 'GitHub rate limit reached; polling will resume after the retry window.';

export function parseGithubPrUrl(value: string): {
  url: string;
  owner: string;
  repo: string;
  number: number;
} {
  const match =
    /^https:\/\/github\.com\/([a-z\d](?:[a-z\d-]*[a-z\d])?)\/([a-z\d_.-]+)\/pull\/([1-9]\d*)\/?$/i.exec(
      value.trim(),
    );
  if (!match || match[2] === '.' || match[2] === '..' || !Number.isSafeInteger(Number(match[3]))) {
    throw new Error('Expected an HTTPS github.com/{owner}/{repo}/pull/{number} URL.');
  }
  const owner = match[1].toLowerCase();
  const repo = match[2].toLowerCase();
  const number = match[3];
  return {
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
    owner,
    repo,
    number: Number(number),
  };
}

export function parsePollInterval(value: string | undefined): number {
  if (value === undefined) return 60_000;
  const interval = Number(value);
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(interval) ||
    interval < 15_000 ||
    interval > 2_147_483_647
  ) {
    throw new Error('FOGGY_POLL_INTERVAL_MS must be an integer between 15000 and 2147483647.');
  }
  return interval;
}

class GithubError extends Error {}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GithubError('GitHub returned an invalid response.');
  }
  return value as Record<string, unknown>;
}

function errorMessage(error: unknown): string {
  return error instanceof GithubError
    ? error.message
    : 'GitHub request failed. Check network connectivity and token access.';
}

export interface GithubPollerOptions {
  token?: string;
  intervalMs?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

function discoveryRequest(token: string, fetcher: typeof fetch, signal: AbortSignal) {
  return async (path: string): Promise<unknown> => {
    const response = await fetcher(`${API_ROOT}${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'foggybrain',
      },
      redirect: 'error',
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401)
        throw new GithubError('GitHub authentication failed for the selected server credential.');
      if (response.status === 403 || response.status === 429)
        throw new GithubError(
          'GitHub access denied or rate limited. Check selected credential permissions and retry later.',
        );
      throw new GithubError(`GitHub discovery returned HTTP ${response.status}.`);
    }
    return response.json();
  };
}

export async function discoverOwnedRepositories(
  token: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<WorkspaceRepositories> {
  const signal = AbortSignal.timeout(15_000);
  const request = discoveryRequest(token, fetcher, signal);
  try {
    const user = record(await request('/user'));
    if (
      typeof user.login !== 'string' ||
      !/^[a-z\d][a-z\d-]*$/i.test(user.login) ||
      !Number.isSafeInteger(user.id) ||
      (user.id as number) <= 0
    )
      throw new GithubError('GitHub returned an invalid user.');
    const repositories = new Map<number, WorkspaceRepositories['repositories'][number]>();
    // Construct every page locally; never follow remote Link headers with credentials.
    for (let page = 1; page <= 10; page++) {
      const items = await request(
        `/user/repos?visibility=private&affiliation=owner&sort=full_name&per_page=100&page=${page}`,
      );
      if (!Array.isArray(items) || items.length > 100)
        throw new GithubError('GitHub returned an invalid repository list.');
      for (const item of items) {
        const repo = record(item);
        const owner = record(repo.owner);
        if (repo.private !== true || owner.id !== user.id || owner.type !== 'User') continue;
        if (
          !Number.isSafeInteger(repo.id) ||
          (repo.id as number) <= 0 ||
          typeof repo.name !== 'string' ||
          !/^[a-z\d_.-]+$/i.test(repo.name) ||
          repo.name === '.' ||
          repo.name === '..' ||
          typeof owner.login !== 'string' ||
          owner.login.toLowerCase() !== user.login.toLowerCase() ||
          repo.full_name !== `${owner.login}/${repo.name}` ||
          typeof repo.default_branch !== 'string' ||
          !repo.default_branch.trim() ||
          repo.default_branch.length > 255 ||
          /[\x00-\x1f\x7f]/.test(repo.default_branch)
        )
          throw new GithubError('GitHub returned an invalid repository.');
        repositories.set(repo.id as number, {
          id: repo.id as number,
          fullName: repo.full_name as string,
          defaultBranch: repo.default_branch,
        });
      }
      if (items.length < 100)
        return {
          login: user.login,
          repositories: [...repositories.values()].sort((a, b) =>
            a.fullName.localeCompare(b.fullName),
          ),
        };
    }
    throw new GithubError(
      'Repository discovery reached its 1,000-entry limit. Narrow the selected token repository access and retry.',
    );
  } catch (error) {
    throw new DomainError(
      signal.aborted ? 'GitHub repository discovery timed out.' : errorMessage(error),
      502,
    );
  }
}

export async function discoverRepositoryEntries(
  token: string,
  repo: string,
  branch: string | undefined,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<WorkspaceBranches | WorkspaceFiles> {
  const signal = AbortSignal.timeout(15_000);
  const request = discoveryRequest(token, fetcher, signal);
  const root = `/repos/${repo.split('/').map(encodeURIComponent).join('/')}`;
  try {
    const user = record(await request('/user'));
    const repository = record(await request(root));
    const owner = record(repository.owner);
    if (
      !Number.isSafeInteger(user.id) ||
      (user.id as number) <= 0 ||
      typeof user.login !== 'string' ||
      repository.private !== true ||
      owner.type !== 'User' ||
      owner.id !== user.id ||
      typeof owner.login !== 'string' ||
      owner.login.toLowerCase() !== user.login.toLowerCase() ||
      typeof repository.full_name !== 'string' ||
      repository.full_name.toLowerCase() !== repo.toLowerCase() ||
      repo.split('/')[0].toLowerCase() !== user.login.toLowerCase()
    )
      throw new GithubError(
        'Discovery requires a private repository owned by the selected credential account.',
      );
    if (branch === undefined) {
      const branches = new Set<string>();
      for (let page = 1; page <= 10; page++) {
        const items = await request(`${root}/branches?per_page=100&page=${page}`);
        if (!Array.isArray(items) || items.length > 100)
          throw new GithubError('GitHub returned an invalid branch list.');
        for (const item of items) {
          const entry = record(item);
          if (typeof entry.name !== 'string' || !entry.name || entry.name.length > 512)
            throw new GithubError('GitHub returned an invalid branch.');
          if (safeSyncRef(entry.name)) branches.add(entry.name);
        }
        if (items.length < 100) return { branches: [...branches].sort() };
      }
      throw new GithubError('Branch discovery reached its 1,000-entry limit.');
    }
    // Resolve an actual branch first: a tag or arbitrary tree SHA is not a branch selection.
    const selected = record(await request(`${root}/branches/${encodeURIComponent(branch)}`));
    const commit = record(selected.commit);
    if (
      selected.name !== branch ||
      typeof commit.sha !== 'string' ||
      !/^[a-f\d]{40}$/i.test(commit.sha)
    )
      throw new GithubError('GitHub returned an invalid branch.');
    const tree = record(await request(`${root}/git/trees/${commit.sha}?recursive=1`));
    if (tree.truncated !== false || !Array.isArray(tree.tree) || tree.tree.length > 100_000)
      throw new GithubError('GitHub file tree is incomplete or exceeds the 100,000-entry limit.');
    const paths = new Set<string>();
    for (const item of tree.tree) {
      const entry = record(item);
      if (
        typeof entry.path !== 'string' ||
        !['blob', 'tree', 'commit'].includes(String(entry.type))
      )
        throw new GithubError('GitHub returned an invalid file tree.');
      if (
        entry.type === 'blob' &&
        ['100644', '100755'].includes(String(entry.mode)) &&
        safeSyncRef(entry.path) &&
        /\.json$/i.test(entry.path)
      )
        paths.add(entry.path);
      if (paths.size > 2_000)
        throw new GithubError('File discovery exceeds the 2,000 JSON candidate limit.');
    }
    return { paths: [...paths].sort() };
  } catch (error) {
    throw new DomainError(
      signal.aborted ? 'GitHub discovery timed out.' : errorMessage(error),
      502,
    );
  }
}

export class GithubPoller {
  private readonly token: string;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly store: Pick<Store, 'snapshot' | 'updatePr'>;
  private state: GithubStatus;
  private prs: GithubPr[] = [];
  private pending: Promise<GithubStatus> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private controller: AbortController | null = null;
  private stopped = false;
  private retryAt = 0;

  constructor(store: Pick<Store, 'snapshot' | 'updatePr'>, options: GithubPollerOptions = {}) {
    this.store = store;
    this.token = options.token?.trim() ?? '';
    this.intervalMs = parsePollInterval(String(options.intervalMs ?? 60_000));
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 2_147_483_647
    ) {
      throw new Error('GitHub timeout must be a positive integer no greater than 2147483647.');
    }
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.state = {
      configured: Boolean(this.token),
      login: null,
      lastSync: null,
      error: this.token ? null : NOT_CONFIGURED,
      syncing: false,
    };
  }

  getStatus(): GithubStatus {
    return { ...this.state };
  }

  getPrs(): GithubPr[] {
    return this.prs.map((pr) => ({ ...pr }));
  }

  start(): void {
    if (this.timer || this.stopped) return;
    void this.sync();
    this.timer = setInterval(() => {
      void this.sync();
    }, this.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.controller?.abort();
    await this.pending;
  }

  sync(): Promise<GithubStatus> {
    if (this.pending) return this.pending;
    if (this.stopped) return Promise.resolve(this.getStatus());
    if (this.now() < this.retryAt) {
      this.state.error = RATE_LIMITED;
      return Promise.resolve(this.getStatus());
    }
    this.state.syncing = true;
    this.controller = new AbortController();
    this.pending = this.poll()
      .catch((error) => {
        if (!this.stopped) this.state.error = errorMessage(error);
      })
      .then(() => {
        this.state.syncing = false;
        this.controller = null;
        this.pending = null;
        return this.getStatus();
      });
    return this.pending;
  }

  private async request(path: string): Promise<unknown> {
    // All paths are constructed here, never taken from API links or user URLs.
    const url = new URL(path, API_ROOT);
    if (url.origin !== API_ROOT || !path.startsWith('/'))
      throw new GithubError('Invalid GitHub API path.');
    if (this.now() < this.retryAt) throw new GithubError(RATE_LIMITED);
    const signal = AbortSignal.any([this.controller!.signal, AbortSignal.timeout(this.timeoutMs)]);
    try {
      const response = await this.fetcher(url.href, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'foggybrain',
        },
        redirect: 'error',
        signal,
      });
      const exhausted = response.headers.get('x-ratelimit-remaining') === '0';
      const retry = response.headers.get('retry-after');
      const limited =
        response.status === 429 || (response.status === 403 && (exhausted || retry !== null));
      if (limited || exhausted) {
        const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
        const retryTime =
          retry === null
            ? 0
            : /^\d+(\.\d+)?$/.test(retry)
              ? this.now() + Number(retry) * 1000
              : Date.parse(retry);
        this.retryAt = Math.max(
          this.now() + (limited ? 60_000 : 1000),
          Number.isFinite(reset) ? reset : 0,
          Number.isFinite(retryTime) ? retryTime : 0,
        );
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (limited) throw new GithubError(RATE_LIMITED);
        if (response.status === 401)
          throw new GithubError('GitHub authentication failed. Check GH_TOKEN or GITHUB_TOKEN.');
        if (response.status === 403)
          throw new GithubError(
            'GitHub access denied. Check token permissions and repository access.',
          );
        if (response.status === 404)
          throw new GithubError(
            'GitHub pull request or resource was not found, or the token does not have access.',
          );
        throw new GithubError(`GitHub API returned HTTP ${response.status}.`);
      }
      return await response.json();
    } catch (error) {
      if (signal.aborted && !this.stopped) throw new GithubError('GitHub request timed out.');
      throw error;
    }
  }

  private async authoredPrs(): Promise<GithubPr[]> {
    if (!this.state.login) {
      const user = record(await this.request('/user'));
      if (typeof user.login !== 'string' || !/^[a-z\d][a-z\d-]*$/i.test(user.login)) {
        throw new GithubError('GitHub returned an invalid user.');
      }
      this.state.login = user.login;
    }
    const prs = new Map<string, GithubPr>();
    // GitHub search is capped at 1,000 results. Refuse partial caches rather than silently truncate.
    for (let page = 1; page <= 10; page++) {
      const query = new URLSearchParams({
        q: `is:pr is:open author:${this.state.login}`,
        sort: 'updated',
        order: 'desc',
        per_page: '100',
        page: String(page),
      });
      const result = record(await this.request(`/search/issues?${query}`));
      if (
        !Number.isSafeInteger(result.total_count) ||
        (result.total_count as number) < 0 ||
        !Array.isArray(result.items) ||
        typeof result.incomplete_results !== 'boolean'
      ) {
        throw new GithubError('GitHub returned an invalid search response.');
      }
      if (result.incomplete_results || (result.total_count as number) > 1000) {
        throw new GithubError(
          "Authored PR search is incomplete or exceeds GitHub's 1,000-result limit; the previous cache was retained.",
        );
      }
      const expected = Math.min(
        100,
        Math.max(0, (result.total_count as number) - (page - 1) * 100),
      );
      if (result.items.length < expected || result.items.length > 100) {
        throw new GithubError(
          'GitHub returned a partial authored PR search; the previous cache was retained.',
        );
      }
      for (const item of result.items) {
        const pr = record(item);
        if (pr.state === 'closed') continue;
        if (
          pr.state !== 'open' ||
          typeof pr.html_url !== 'string' ||
          typeof pr.title !== 'string' ||
          typeof pr.updated_at !== 'string' ||
          !Number.isFinite(Date.parse(pr.updated_at)) ||
          typeof pr.draft !== 'boolean' ||
          !pr.pull_request
        ) {
          throw new GithubError('GitHub returned an invalid authored pull request.');
        }
        let parsed: ReturnType<typeof parseGithubPrUrl>;
        try {
          parsed = parseGithubPrUrl(pr.html_url);
        } catch {
          throw new GithubError('GitHub returned an invalid pull request URL.');
        }
        if (pr.number !== parsed.number)
          throw new GithubError('GitHub returned an invalid pull request number.');
        prs.set(parsed.url, {
          url: parsed.url,
          title: pr.title,
          number: parsed.number,
          repository: `${parsed.owner}/${parsed.repo}`,
          state: 'open',
          draft: pr.draft,
          updatedAt: pr.updated_at,
        });
      }
      if (page * 100 >= (result.total_count as number)) return [...prs.values()];
    }
    throw new GithubError(
      'Authored PR search exceeded its pagination limit; the previous cache was retained.',
    );
  }

  private current(task: TaskView): boolean {
    return (
      !this.stopped &&
      this.store
        .snapshot()
        .tasks.some(
          (current) =>
            current.id === task.id &&
            current.kind === 'pr' &&
            current.prUrl === task.prUrl &&
            current.createdAt === task.createdAt,
        )
    );
  }

  private apply(
    task: TaskView,
    update: { state?: PrState; checkedAt: string; error: string | null },
  ): void {
    // There is no await between the guard and write, so URL edits/deletions cannot race the update.
    if (this.current(task)) this.store.updatePr(task.id, update);
  }

  private async poll(): Promise<void> {
    const tasks = this.store.snapshot().tasks.filter((task) => task.kind === 'pr' && task.prUrl);
    const errors: string[] = [];
    if (!this.token) {
      for (const task of tasks)
        this.apply(task, { checkedAt: new Date(this.now()).toISOString(), error: NOT_CONFIGURED });
      this.state.error = NOT_CONFIGURED;
      return;
    }
    try {
      const prs = await this.authoredPrs();
      if (!this.stopped) this.prs = prs;
    } catch (error) {
      errors.push(`Authored PRs: ${errorMessage(error)}`);
    }
    const byUrl = new Map<string, TaskView[]>();
    for (const task of tasks) byUrl.set(task.prUrl!, [...(byUrl.get(task.prUrl!) ?? []), task]);
    for (const [url, group] of byUrl) {
      if (this.stopped) return;
      if (!group.some((task) => this.current(task))) continue;
      try {
        let parsed: ReturnType<typeof parseGithubPrUrl>;
        try {
          parsed = parseGithubPrUrl(url);
        } catch {
          throw new GithubError('Tracked PR URL is not a valid GitHub pull request URL.');
        }
        const pr = record(
          await this.request(
            `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/pulls/${parsed.number}`,
          ),
        );
        if ((pr.state !== 'open' && pr.state !== 'closed') || typeof pr.merged !== 'boolean') {
          throw new GithubError('GitHub returned an invalid pull request state.');
        }
        const update = {
          state: (pr.merged ? 'merged' : pr.state) as PrState,
          checkedAt: new Date(this.now()).toISOString(),
          error: null,
        };
        for (const task of group) this.apply(task, update);
      } catch (error) {
        const message = errorMessage(error);
        if (group.some((task) => this.current(task))) errors.push(`Tracked PRs: ${message}`);
        for (const task of group)
          this.apply(task, { checkedAt: new Date(this.now()).toISOString(), error: message });
      }
    }
    if (!this.stopped) {
      this.state.lastSync = new Date(this.now()).toISOString();
      this.state.error = errors.length ? [...new Set(errors)].join(' ') : null;
    }
  }
}
