import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverRepositoryEntries } from './github.js';

function fixture(reply: (url: URL) => Response, repository: Record<string, unknown> = {}) {
  const calls: URL[] = [];
  let signal: AbortSignal | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(url);
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.method ?? 'GET', 'GET');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer secret');
    assert.ok(init?.signal);
    signal ??= init.signal;
    assert.equal(init.signal, signal);
    if (url.pathname === '/user') return Response.json({ id: 1, login: 'owner' });
    if (url.pathname === '/repos/owner/state')
      return Response.json({
        private: true,
        full_name: 'owner/state',
        owner: { id: 1, login: 'owner', type: 'User' },
        ...repository,
      });
    return reply(url);
  };
  return { calls, fetcher };
}

test('branches paginate locally, ignore links, filter unsupported refs and deduplicate', async () => {
  const { calls, fetcher } = fixture((url) => {
    assert.equal(url.pathname, '/repos/owner/state/branches');
    assert.equal(url.searchParams.get('per_page'), '100');
    return Response.json(
      url.searchParams.get('page') === '1'
        ? Array.from({ length: 100 }, () => ({ name: 'feature/state' }))
        : [{ name: 'main' }, { name: 'feature/state' }, { name: 'bad..ref' }],
      { headers: { Link: '<https://evil.example/secret>; rel="next"' } },
    );
  });
  assert.deepEqual(await discoverRepositoryEntries('secret', 'owner/state', undefined, fetcher), {
    branches: ['feature/state', 'main'],
  });
  assert.equal(calls.length, 4);
});

test('discovery uses one overall deadline and sanitizes abort failures', async (t) => {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    assert.equal(milliseconds, 15_000);
    return timeout(5);
  });
  const keepAlive = setTimeout(() => {}, 1000);
  t.after(() => clearTimeout(keepAlive));
  const fetcher: typeof fetch = async (_input, init) =>
    new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('secret')), { once: true });
    });
  await assert.rejects(
    discoverRepositoryEntries('secret', 'owner/state', undefined, fetcher),
    /timed out/,
  );
});

test('branch discovery rejects incomplete pagination and malformed payloads', async () => {
  for (const payload of [
    Array.from({ length: 100 }, () => ({ name: 'main' })),
    {},
    [{ name: 1 }],
  ]) {
    const { calls, fetcher } = fixture(() => Response.json(payload));
    await assert.rejects(
      discoverRepositoryEntries('secret', 'owner/state', undefined, fetcher),
      /limit|invalid/,
    );
    assert.ok(calls.length <= 12);
  }
});

test('discovery rejects public, organization, collaborator and mismatched repositories before listing', async () => {
  for (const repo of [
    { private: false },
    { owner: { id: 1, login: 'owner', type: 'Organization' } },
    { owner: { id: 2, login: 'other', type: 'User' } },
    { full_name: 'owner/other' },
  ]) {
    const { fetcher } = fixture(() => assert.fail('Must not list entries'), repo);
    await assert.rejects(
      discoverRepositoryEntries('secret', 'owner/state', undefined, fetcher),
      /private repository owned/,
    );
  }
});

test('files resolve encoded actual branch and list safe JSON blobs without fetching contents', async () => {
  const { fetcher } = fixture((url) => {
    if (url.pathname === '/repos/owner/state/branches/feature%2Fstate')
      return Response.json({ name: 'feature/state', commit: { sha: 'a'.repeat(40) } });
    assert.equal(url.pathname, `/repos/owner/state/git/trees/${'a'.repeat(40)}`);
    assert.equal(url.search, '?recursive=1');
    return Response.json({
      truncated: false,
      tree: [
        { path: 'nested/state.json', type: 'blob', mode: '100644' },
        { path: 'README.md', type: 'blob', mode: '100644' },
        { path: '../bad.json', type: 'blob', mode: '100644' },
        { path: 'link.json', type: 'blob', mode: '120000' },
        { path: 'folder.json', type: 'tree', mode: '040000' },
      ],
    });
  });
  assert.deepEqual(
    await discoverRepositoryEntries('secret', 'owner/state', 'feature/state', fetcher),
    { paths: ['nested/state.json'] },
  );
});

test('files reject truncated, oversized, malformed trees and missing branches, sanitizing upstream errors', async () => {
  for (const tree of [
    { truncated: true, tree: [] },
    { tree: [] },
    { truncated: false, tree: [{}] },
    {
      truncated: false,
      tree: Array.from({ length: 2001 }, (_, i) => ({
        path: `${i}.json`,
        type: 'blob',
        mode: '100644',
      })),
    },
    { truncated: false, tree: Array(100001).fill(null) },
  ]) {
    const { fetcher } = fixture((url) =>
      Response.json(
        url.pathname.includes('/branches/')
          ? { name: 'main', commit: { sha: 'a'.repeat(40) } }
          : tree,
      ),
    );
    await assert.rejects(
      discoverRepositoryEntries('secret', 'owner/state', 'main', fetcher),
      /tree|limit/,
    );
  }
  for (const status of [301, 401, 403, 404, 429, 500]) {
    const { fetcher } = fixture(
      () => new Response('secret', { status, headers: { Location: 'https://evil.example' } }),
    );
    await assert.rejects(
      discoverRepositoryEntries('secret', 'owner/state', 'main', fetcher),
      (error: Error) => {
        assert.ok(!error.message.includes('secret'));
        return true;
      },
    );
  }
  const { fetcher } = fixture(() => {
    throw new Error('secret');
  });
  await assert.rejects(
    discoverRepositoryEntries('secret', 'owner/state', 'main', fetcher),
    /Check network/,
  );
});
