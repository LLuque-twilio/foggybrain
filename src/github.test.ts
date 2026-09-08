import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from './core.js';
import { GithubPoller, parseGithubPrUrl, parsePollInterval } from './github.js';
import type { PrMergeStatus, Snapshot, TaskView } from './shared.js';

const TOKEN = 'test-secret-never-a-real-credential';
const NOW = Date.parse('2026-09-08T12:00:00Z');

function task(id: string, prUrl = `https://github.com/other/private/pull/${id}`): TaskView {
  return {
    id,
    prUrl,
    title: `PR ${id}`,
    description: '',
    kind: 'pr',
    parentId: null,
    manualDone: false,
    prState: 'unknown',
    prMergeStatus: 'unknown',
    prCheckedAt: null,
    prError: null,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    status: 'available',
    ownSatisfied: false,
    waitingOn: [],
    childrenIds: [],
  };
}

function fakeStore(tasks: TaskView[] = []) {
  const snapshot: Snapshot = { tasks, dependencies: [], references: [], layouts: [] };
  const updates: ({ id: string } & Parameters<Store['updatePr']>[1])[] = [];
  const store = {
    snapshot: () => structuredClone(snapshot),
    updatePr(id: string, update: Parameters<Store['updatePr']>[1]) {
      const task = snapshot.tasks.find((task) => task.id === id);
      assert.ok(task, 'poller must not update deleted tasks');
      updates.push({ id, ...update });
      if (update.state !== undefined) task.prState = update.state;
      if (update.mergeStatus !== undefined) task.prMergeStatus = update.mergeStatus;
      task.prCheckedAt = update.checkedAt;
      task.prError = update.error;
      return task;
    },
  } as ConstructorParameters<typeof GithubPoller>[0];
  return { store, snapshot, updates };
}

function json(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function authored(number: number) {
  return {
    html_url: `https://github.com/me/project/pull/${number}`,
    title: `Authored ${number}`,
    number,
    state: 'open',
    draft: false,
    updated_at: new Date(NOW).toISOString(),
    pull_request: { url: `https://api.github.com/repos/me/project/pulls/${number}` },
  };
}

function search(items: unknown[] = [], total = items.length) {
  return json({ items, total_count: total, incomplete_results: false });
}

function metadata(fields: Record<string, unknown> = {}, checks: string | null = 'SUCCESS') {
  return {
    data: {
      repository: {
        pullRequest: {
          state: 'OPEN',
          isDraft: false,
          reviewDecision: 'APPROVED',
          mergeStateStatus: 'CLEAN',
          commits: {
            nodes: [{ commit: { statusCheckRollup: checks === null ? null : { state: checks } } }],
          },
          ...fields,
        },
      },
    },
  };
}

function mockFetch(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const calls: URL[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push(url);
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${TOKEN}`);
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    return handler(url, init!);
  }) as typeof fetch;
  return { fetcher, calls };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('only canonical GitHub HTTPS pull request URLs are accepted', () => {
  assert.deepEqual(parseGithubPrUrl(' https://github.com/Owner/my.repo/pull/42/ '), {
    url: 'https://github.com/owner/my.repo/pull/42',
    owner: 'owner',
    repo: 'my.repo',
    number: 42,
  });
  for (const url of [
    'http://github.com/o/r/pull/1',
    'https://api.github.com/o/r/pull/1',
    'https://github.com.evil.test/o/r/pull/1',
    'https://github.com@evil.test/o/r/pull/1',
    'https://token@github.com/o/r/pull/1',
    'https://github.com:443/o/r/pull/1',
    'https://github.com/o/r/issues/1',
    'https://github.com/o/r/pull/1/files',
    'https://github.com/o/r/pull/1?redirect=evil',
    'https://github.com/o/r/pull/1#x',
    'https://github.com/o/%2e%2e/pull/1',
    'https://github.com/o/../pull/1',
    'https://github.com/o/r/pull/0',
    'https://github.com/o/r/pull/9007199254740992',
    'https://github.com/o/r/pull/1\n/evil',
    'https://github.com\\evil.test/o/r/pull/1',
  ])
    assert.throws(() => parseGithubPrUrl(url), /Expected an HTTPS/, url);
});

test('poll interval defaults to 60 seconds and rejects unsafe timer values', () => {
  assert.equal(parsePollInterval(undefined), 60_000);
  assert.equal(parsePollInterval('15000'), 15_000);
  for (const value of [
    '',
    '0',
    '14999',
    '-1',
    '15.5',
    '15000ms',
    'Infinity',
    '2147483648',
    ' 60000 ',
    '6e4',
  ]) {
    assert.throws(() => parsePollInterval(value));
  }
});

test('unconfigured polling makes no requests and retains verified task state', async () => {
  const fake = fakeStore([task('1')]);
  fake.snapshot.tasks[0].prState = 'merged';
  fake.snapshot.tasks[0].prMergeStatus = 'ready';
  const poller = new GithubPoller(fake.store, {
    fetch: async () => {
      assert.fail('unexpected network');
    },
    now: () => NOW,
  });
  const status = await poller.sync();
  assert.equal(status.configured, false);
  assert.equal(status.syncing, false);
  assert.match(status.error!, /not configured/);
  assert.equal(fake.snapshot.tasks[0].prState, 'merged');
  assert.equal(fake.snapshot.tasks[0].prMergeStatus, 'ready');
  assert.match(fake.snapshot.tasks[0].prError!, /not configured/);
  assert.deepEqual(poller.getPrs(), []);
});

test('authored OPEN cache is independent of tracked accessible PRs and distinguishes closed from merged', async () => {
  const fake = fakeStore([
    task('1'),
    task('2'),
    task('3'),
    task('4', 'https://github.com/other/private/pull/1'),
  ]);
  const mock = mockFetch((url) => {
    if (url.pathname === '/user') return json({ login: 'me' });
    if (url.pathname === '/search/issues') {
      assert.equal(url.searchParams.get('q'), 'is:pr is:open author:me');
      return search([authored(9), { ...authored(10), state: 'closed' }]);
    }
    if (url.pathname.endsWith('/1')) return json({ state: 'closed', merged: true });
    if (url.pathname.endsWith('/2')) return json({ state: 'closed', merged: false });
    if (url.pathname === '/graphql') return json(metadata());
    return json({ state: 'open', merged: false });
  });
  const poller = new GithubPoller(fake.store, {
    token: TOKEN,
    fetch: mock.fetcher,
    now: () => NOW,
  });
  const status = await poller.sync();
  assert.equal(status.error, null);
  assert.equal(status.lastSync, new Date(NOW).toISOString());
  assert.deepEqual(
    fake.snapshot.tasks.map((task) => task.prState),
    ['merged', 'closed', 'open', 'merged'],
  );
  assert.equal(mock.calls.filter((url) => url.pathname.endsWith('/pulls/1')).length, 1);
  assert.deepEqual(poller.getPrs(), [
    {
      url: 'https://github.com/me/project/pull/9',
      title: 'Authored 9',
      number: 9,
      repository: 'me/project',
      state: 'open',
      draft: false,
      updatedAt: new Date(NOW).toISOString(),
    },
  ]);
  const copy = poller.getPrs();
  copy[0].title = 'mutated';
  assert.equal(poller.getPrs()[0].title, 'Authored 9');
  assert.equal(JSON.stringify(status).includes(TOKEN), false);
});

test('list and tracked errors retain caches/verified state and clear independently after recovery', async () => {
  const fake = fakeStore([task('1')]);
  let listFails = false;
  let trackedFails = false;
  const mock = mockFetch((url) => {
    if (url.pathname === '/user') return json({ login: 'me' });
    if (url.pathname === '/search/issues')
      return listFails ? json({ message: TOKEN }, 500) : search([authored(9)]);
    return trackedFails ? json({ message: TOKEN }, 404) : json({ state: 'closed', merged: true });
  });
  const poller = new GithubPoller(fake.store, { token: TOKEN, fetch: mock.fetcher });
  await poller.sync();
  listFails = trackedFails = true;
  let status = await poller.sync();
  assert.match(status.error!, /Authored PRs:.*500.*Tracked PRs:.*not found/);
  assert.equal(fake.snapshot.tasks[0].prState, 'merged');
  assert.match(fake.snapshot.tasks[0].prError!, /not found/);
  assert.equal(poller.getPrs().length, 1);
  assert.equal(JSON.stringify([status, fake.updates]).includes(TOKEN), false);
  trackedFails = false;
  status = await poller.sync();
  assert.match(status.error!, /Authored PRs/);
  assert.equal(fake.snapshot.tasks[0].prError, null);
  listFails = false;
  status = await poller.sync();
  assert.equal(status.error, null);
  assert.equal(mock.calls.filter((url) => url.pathname === '/user').length, 1);
});

test('tracked PR polling continues even if the authored-user lookup fails', async () => {
  const fake = fakeStore([task('1')]);
  const mock = mockFetch((url) => {
    if (url.pathname === '/user') return json({}, 403);
    if (url.pathname === '/graphql') return json(metadata());
    return json({ state: 'open', merged: false });
  });
  const poller = new GithubPoller(fake.store, { token: TOKEN, fetch: mock.fetcher });
  const status = await poller.sync();
  assert.match(status.error!, /access denied/);
  assert.equal(fake.snapshot.tasks[0].prState, 'open');
  assert.equal(fake.snapshot.tasks[0].prError, null);
});

test('pagination is bounded and an incomplete search does not replace the cache', async () => {
  const fake = fakeStore();
  let mode: 'pages' | 'too-many' | 'incomplete' | 'partial' = 'pages';
  const mock = mockFetch((url) => {
    if (url.pathname === '/user') return json({ login: 'me' });
    if (mode === 'too-many') return search([], 1001);
    if (mode === 'incomplete')
      return json({ total_count: 1, incomplete_results: true, items: [authored(500)] });
    if (mode === 'partial') return search([], 1);
    assert.equal(url.searchParams.get('per_page'), '100');
    return url.searchParams.get('page') === '1'
      ? search(
          Array.from({ length: 100 }, (_, i) => authored(i + 1)),
          101,
        )
      : search([authored(101)], 101);
  });
  const poller = new GithubPoller(fake.store, { token: TOKEN, fetch: mock.fetcher });
  assert.equal((await poller.sync()).error, null);
  assert.equal(poller.getPrs().length, 101);
  assert.deepEqual(
    mock.calls
      .filter((url) => url.pathname === '/search/issues')
      .map((url) => url.searchParams.get('page')),
    ['1', '2'],
  );
  mode = 'too-many';
  assert.match((await poller.sync()).error!, /1,000-result limit/);
  assert.equal(poller.getPrs().length, 101);
  mode = 'incomplete';
  assert.match((await poller.sync()).error!, /incomplete/);
  assert.equal(poller.getPrs().length, 101);
  mode = 'partial';
  assert.match((await poller.sync()).error!, /partial/);
  assert.equal(poller.getPrs().length, 101);
});

test('malicious tracked and response URLs never become token-bearing fetch destinations', async () => {
  const fake = fakeStore([task('1', 'https://attacker.test/o/r/pull/1')]);
  const mock = mockFetch((url) =>
    url.pathname === '/user'
      ? json({ login: 'me' })
      : search([{ ...authored(1), html_url: 'https://attacker.test/o/r/pull/1' }]),
  );
  const poller = new GithubPoller(fake.store, { token: TOKEN, fetch: mock.fetcher });
  const status = await poller.sync();
  assert.match(status.error!, /invalid pull request URL/);
  assert.equal(mock.calls.length, 2);
  assert.match(fake.snapshot.tasks[0].prError!, /not a valid/);
  assert.deepEqual(poller.getPrs(), []);
});

test('changed URLs and deleted tasks discard both successful and failed in-flight responses', async () => {
  for (const mutation of ['change', 'delete'] as const) {
    for (const failed of [false, true]) {
      const fake = fakeStore([task('1')]);
      const requested = deferred<void>();
      const response = deferred<Response>();
      const mock = mockFetch((url) => {
        if (url.pathname === '/user') return json({ login: 'me' });
        if (url.pathname === '/search/issues') return search();
        requested.resolve();
        return response.promise;
      });
      const poller = new GithubPoller(fake.store, { token: TOKEN, fetch: mock.fetcher });
      const sync = poller.sync();
      await requested.promise;
      if (mutation === 'delete') fake.snapshot.tasks = [];
      else fake.snapshot.tasks[0].prUrl = 'https://github.com/new/repo/pull/2';
      response.resolve(failed ? json({}, 404) : json({ state: 'closed', merged: true }));
      await sync;
      assert.equal(fake.updates.length, 0, `${mutation}, failed=${failed}`);
    }
  }
});

test('simultaneous manual syncs share one poll and expose syncing status', async () => {
  const fake = fakeStore();
  const response = deferred<Response>();
  const mock = mockFetch((url) => (url.pathname === '/user' ? response.promise : search()));
  const poller = new GithubPoller(fake.store, { token: TOKEN, fetch: mock.fetcher });
  const first = poller.sync();
  assert.equal(poller.getStatus().syncing, true);
  assert.strictEqual(poller.sync(), first);
  assert.equal(mock.calls.length, 1);
  response.resolve(json({ login: 'me' }));
  assert.equal((await first).syncing, false);
});

test('rate limits honor reset/retry windows without overlapping or losing verified states', async () => {
  for (const code of [403, 429]) {
    const fake = fakeStore([task('1')]);
    fake.snapshot.tasks[0].prState = 'merged';
    let now = NOW;
    let limited = true;
    const mock = mockFetch((url) => {
      if (url.pathname === '/user') return json({ login: 'me' });
      if (url.pathname === '/search/issues') return search();
      if (url.pathname === '/graphql') return json(metadata());
      return limited
        ? json({}, code, {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String((NOW + 120_000) / 1000),
            'retry-after': '90',
          })
        : json({ state: 'open', merged: false });
    });
    const poller = new GithubPoller(fake.store, {
      token: TOKEN,
      fetch: mock.fetcher,
      now: () => now,
    });
    assert.match((await poller.sync()).error!, /rate limit/);
    assert.equal(fake.snapshot.tasks[0].prState, 'merged');
    const count = mock.calls.length;
    now += 119_000;
    assert.match((await poller.sync()).error!, /rate limit/);
    assert.equal(mock.calls.length, count);
    now += 1000;
    limited = false;
    assert.equal((await poller.sync()).error, null);
    assert.equal(fake.snapshot.tasks[0].prState, 'open');
    assert.equal(fake.snapshot.tasks[0].prError, null);
  }
});

test('timeouts become safe errors rather than hanging or revealing fetch exception details', async () => {
  const fake = fakeStore();
  const mock = mockFetch(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener(
          'abort',
          () => {
            reject(new Error(TOKEN));
          },
          { once: true },
        );
      }),
  );
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const poller = new GithubPoller(fake.store, {
      token: TOKEN,
      fetch: mock.fetcher,
      timeoutMs: 10,
    });
    const status = await poller.sync();
    assert.match(status.error!, /timed out/);
    assert.equal(status.error!.includes(TOKEN), false);
    assert.equal(status.syncing, false);
  } finally {
    clearTimeout(keepAlive);
  }
});

test('shutdown aborts in-flight fetches, stops timers, and prevents late writes', async () => {
  const fake = fakeStore([task('1')]);
  const requested = deferred<void>();
  let signal: AbortSignal | null | undefined;
  const mock = mockFetch((url, init) => {
    if (url.pathname === '/user') return json({ login: 'me' });
    if (url.pathname === '/search/issues') return search();
    signal = init.signal;
    requested.resolve();
    return new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  });
  const poller = new GithubPoller(fake.store, { token: TOKEN, fetch: mock.fetcher });
  poller.start();
  poller.start();
  await requested.promise;
  await poller.stop();
  assert.equal(signal!.aborted, true);
  assert.equal(fake.updates.length, 0);
  assert.equal(poller.getStatus().syncing, false);
  const count = mock.calls.length;
  await poller.sync();
  poller.start();
  assert.equal(mock.calls.length, count);
});

test('malformed upstream states and network errors never overwrite verified state or leak secrets', async () => {
  const fake = fakeStore([task('1')]);
  fake.snapshot.tasks[0].prState = 'merged';
  let networkError = false;
  const mock = mockFetch((url) => {
    if (url.pathname === '/user') return json({ login: 'me' });
    if (url.pathname === '/search/issues') return search();
    if (networkError) throw new Error(`network error with ${TOKEN}`);
    return json({ state: 'closed', merged: 'false' });
  });
  const poller = new GithubPoller(fake.store, { token: TOKEN, fetch: mock.fetcher });
  assert.match((await poller.sync()).error!, /invalid pull request state/);
  networkError = true;
  assert.match((await poller.sync()).error!, /request failed/);
  assert.equal(fake.snapshot.tasks[0].prState, 'merged');
  assert.equal(JSON.stringify([poller.getStatus(), fake.updates]).includes(TOKEN), false);
});

test('readiness uses review decisions, merge gates and the latest commit rollup with conservative precedence', async (t) => {
  const cases: [string, Record<string, unknown>, string | null, PrMergeStatus][] = [
    ['approved and clean', {}, 'SUCCESS', 'ready'],
    ['no required review or checks', { reviewDecision: null }, null, 'ready'],
    [
      'draft wins over other gates',
      { isDraft: true, mergeStateStatus: 'DIRTY', reviewDecision: 'CHANGES_REQUESTED' },
      'FAILURE',
      'draft',
    ],
    ['draft merge state', { mergeStateStatus: 'DRAFT' }, 'SUCCESS', 'draft'],
    [
      'conflicts win over review and checks',
      { mergeStateStatus: 'DIRTY', reviewDecision: 'CHANGES_REQUESTED' },
      'FAILURE',
      'conflicts',
    ],
    [
      'changes requested win over checks',
      { reviewDecision: 'CHANGES_REQUESTED' },
      'FAILURE',
      'changes_requested',
    ],
    ['failed check', {}, 'FAILURE', 'checks_failing'],
    ['errored check', {}, 'ERROR', 'checks_failing'],
    ['unstable checks', { mergeStateStatus: 'UNSTABLE' }, 'SUCCESS', 'checks_failing'],
    [
      'checks precede pending review',
      { reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED' },
      'PENDING',
      'checks_pending',
    ],
    ['expected checks', {}, 'EXPECTED', 'checks_pending'],
    [
      'pending review',
      { reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED' },
      'SUCCESS',
      'under_review',
    ],
    ['other branch protection', { mergeStateStatus: 'BLOCKED' }, 'SUCCESS', 'blocked'],
    ['behind base', { mergeStateStatus: 'BEHIND' }, 'SUCCESS', 'blocked'],
    ['hooks remain', { mergeStateStatus: 'HAS_HOOKS' }, 'SUCCESS', 'blocked'],
    [
      'unknown merge gates despite passing checks',
      { mergeStateStatus: 'UNKNOWN' },
      'SUCCESS',
      'unknown',
    ],
    [
      'unknown gates without reviews or checks',
      { mergeStateStatus: 'UNKNOWN', reviewDecision: null },
      null,
      'unknown',
    ],
    ['closed during metadata request', { state: 'CLOSED' }, 'SUCCESS', 'unknown'],
    ['merged during metadata request', { state: 'MERGED' }, 'SUCCESS', 'unknown'],
  ];
  for (const [name, fields, checks, expected] of cases) {
    await t.test(name, async () => {
      const fake = fakeStore([task('1'), task('2', task('1').prUrl!)]);
      const mock = mockFetch((url, init) => {
        if (url.pathname === '/user') return json({ login: 'me' });
        if (url.pathname === '/search/issues') return search();
        if (url.pathname === '/graphql') {
          assert.equal(init.method, 'POST');
          assert.equal(new Headers(init.headers).get('Content-Type'), 'application/json');
          const body = JSON.parse(init.body as string);
          assert.deepEqual(body.variables, { owner: 'other', repo: 'private', number: 1 });
          assert.match(body.query, /state isDraft reviewDecision mergeStateStatus/);
          assert.match(body.query, /commits\(last: 1\).*statusCheckRollup/);
          return json(metadata(fields, checks));
        }
        assert.equal(url.pathname, '/repos/other/private/pulls/1');
        return json({ state: 'open', merged: false, mergeable: true });
      });
      const poller = new GithubPoller(fake.store, { token: TOKEN, fetch: mock.fetcher });
      assert.equal((await poller.sync()).error, null);
      for (const pr of fake.snapshot.tasks) {
        assert.equal(pr.prMergeStatus, expected);
        assert.equal(pr.prState, 'open');
        assert.equal(pr.prError, null);
      }
      assert.equal(mock.calls.filter((url) => url.pathname === '/graphql').length, 1);
    });
  }
});

test('metadata failures preserve readiness but still persist REST verification; recovery clears stale errors', async (t) => {
  const failures = [
    ...[401, 403, 404, 429, 500].map((code) => () => json({ message: TOKEN }, code)),
    () => json({ ...metadata(), errors: [{ message: TOKEN }] }),
    () => json({ data: { repository: null } }),
    () => json(metadata({ reviewDecision: undefined })),
    () => json(metadata({ mergeStateStatus: 'FUTURE_STATE' })),
    () => json(metadata({ isDraft: null })),
    () => json(metadata({ commits: { nodes: [] } })),
    () => json(metadata({}, 'FUTURE_CHECK_STATE')),
    () => new Response(TOKEN),
    () => {
      throw new Error(TOKEN);
    },
  ];
  for (const [index, failure] of failures.entries()) {
    await t.test(`failure ${index + 1}`, async (t) => {
      const store = new Store(':memory:');
      t.after(() => store.close());
      const pr = store.createTask({ title: 'PR', kind: 'pr', prUrl: task('1').prUrl! });
      store.updatePr(pr.id, {
        state: 'merged',
        mergeStatus: 'under_review',
        checkedAt: new Date(NOW).toISOString(),
        error: null,
      });
      let mode: 'metadata-failure' | 'success' | 'rest-failure' = 'metadata-failure';
      let now = NOW;
      const mock = mockFetch((url) => {
        if (url.pathname === '/user') return json({ login: 'me' });
        if (url.pathname === '/search/issues') return search();
        if (url.pathname === '/graphql')
          return mode === 'metadata-failure' ? failure() : json(metadata());
        return mode === 'rest-failure'
          ? json({ message: TOKEN }, 500)
          : json({ state: 'open', merged: false });
      });
      const poller = new GithubPoller(store, { token: TOKEN, fetch: mock.fetcher, now: () => now });
      const failed = await poller.sync();
      assert.match(failed.error!, /readiness metadata unavailable.*stale/);
      let current = store.snapshot().tasks[0];
      assert.equal(current.prState, 'open');
      assert.equal(current.status, 'available');
      assert.equal(current.prMergeStatus, 'under_review');
      assert.match(current.prError!, /readiness metadata unavailable.*stale/);
      assert.equal(current.prCheckedAt, new Date(NOW).toISOString());
      assert.equal(JSON.stringify([failed, current]).includes(TOKEN), false);
      mode = 'success';
      now += 120_000;
      assert.equal((await poller.sync()).error, null);
      current = store.snapshot().tasks[0];
      assert.equal(current.prMergeStatus, 'ready');
      assert.equal(current.prError, null);
      assert.equal(current.ownSatisfied, false);
      assert.equal(current.status, 'available');
      mode = 'rest-failure';
      assert.match((await poller.sync()).error!, /500/);
      current = store.snapshot().tasks[0];
      assert.equal(current.prState, 'open');
      assert.equal(current.prMergeStatus, 'ready');
      assert.match(current.prError!, /500/);
    });
  }
});

test('REST closed and merged results need no metadata access and clear readiness and stale errors', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const pr = store.createTask({ title: 'PR', kind: 'pr', prUrl: task('1').prUrl! });
  let merged = false;
  const mock = mockFetch((url) => {
    if (url.pathname === '/user') return json({ login: 'me' });
    if (url.pathname === '/search/issues') return search();
    assert.notEqual(url.pathname, '/graphql');
    return json({ state: 'closed', merged });
  });
  const poller = new GithubPoller(store, { token: TOKEN, fetch: mock.fetcher });
  for (merged of [false, true]) {
    store.updatePr(pr.id, {
      state: 'open',
      mergeStatus: 'ready',
      checkedAt: new Date(NOW).toISOString(),
      error: 'Stale metadata',
    });
    assert.equal((await poller.sync()).error, null);
    const current = store.snapshot().tasks[0];
    assert.equal(current.prState, merged ? 'merged' : 'closed');
    assert.equal(current.prMergeStatus, 'unknown');
    assert.equal(current.prError, null);
    assert.equal(current.status, merged ? 'completed' : 'available');
  }
});

test('URL changes and deletions while metadata is in flight discard both fields and metadata errors', async () => {
  for (const mutation of ['change', 'delete'] as const) {
    for (const failed of [false, true]) {
      const fake = fakeStore([task('1')]);
      const requested = deferred<void>();
      const response = deferred<Response>();
      const mock = mockFetch((url) => {
        if (url.pathname === '/user') return json({ login: 'me' });
        if (url.pathname === '/search/issues') return search();
        if (url.pathname === '/graphql') {
          requested.resolve();
          return response.promise;
        }
        return json({ state: 'open', merged: false });
      });
      const poller = new GithubPoller(fake.store, { token: TOKEN, fetch: mock.fetcher });
      const sync = poller.sync();
      await requested.promise;
      if (mutation === 'delete') fake.snapshot.tasks = [];
      else fake.snapshot.tasks[0].prUrl = 'https://github.com/new/repo/pull/2';
      response.resolve(failed ? json({ errors: [{ message: TOKEN }] }) : json(metadata()));
      assert.equal((await sync).error, null);
      assert.equal(fake.updates.length, 0);
    }
  }
});
