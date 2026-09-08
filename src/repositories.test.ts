import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverOwnedRepositories } from './github.js';

const repo = (id: number) => ({
  id,
  name: `state-${id}`,
  full_name: `owner/state-${id}`,
  private: true,
  default_branch: 'main',
  owner: { id: 1, login: 'owner', type: 'User' },
});

test('owned private discovery paginates locally, filters ownership and returns safe fields', async () => {
  const paths: string[] = [];
  const result = await discoverOwnedRepositories('secret', async (input, init) => {
    const url = new URL(String(input));
    paths.push(url.pathname + url.search);
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    if (url.pathname === '/user') return Response.json({ id: 1, login: 'owner' });
    const page = url.searchParams.get('page');
    return Response.json(
      page === '1'
        ? Array.from({ length: 100 }, (_, i) => repo(i + 1))
        : [
            repo(101),
            repo(1),
            { ...repo(102), private: false },
            { ...repo(103), owner: { id: 2, login: 'other', type: 'User' } },
            { ...repo(104), owner: { id: 1, login: 'owner', type: 'Organization' } },
          ],
      { headers: { Link: '<https://evil.example/steal>; rel="next"' } },
    );
  });
  assert.equal(result.login, 'owner');
  assert.equal(result.repositories.length, 101);
  assert.deepEqual(Object.keys(result.repositories[0]), ['id', 'fullName', 'defaultBranch']);
  assert.equal(paths.length, 3);
  assert.match(paths[2], /page=2$/);
});

test('discovery refuses partial results at a bounded page limit', async () => {
  let requests = 0;
  await assert.rejects(
    discoverOwnedRepositories('secret', async (input) => {
      requests++;
      return Response.json(
        String(input).endsWith('/user')
          ? { id: 1, login: 'owner' }
          : Array.from({ length: 100 }, (_, i) => repo(i + 1)),
      );
    }),
    /1,000-entry limit/,
  );
  assert.equal(requests, 11);
});

test('discovery handles empty results and sanitizes remote failures and invalid responses', async () => {
  assert.deepEqual(
    await discoverOwnedRepositories('secret', async (input) =>
      Response.json(String(input).endsWith('/user') ? { id: 1, login: 'owner' } : []),
    ),
    { login: 'owner', repositories: [] },
  );
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(
      discoverOwnedRepositories('secret', async () => new Response('secret', { status })),
      (error: Error) => !error.message.includes('secret') && /GitHub/.test(error.message),
    );
  }
  for (const invalid of [
    {},
    [null],
    [{ ...repo(1), full_name: 'https://evil.example' }],
    [{ ...repo(1), default_branch: null }],
  ]) {
    await assert.rejects(
      discoverOwnedRepositories('secret', async (input) =>
        Response.json(String(input).endsWith('/user') ? { id: 1, login: 'owner' } : invalid),
      ),
      /invalid/,
    );
  }
  await assert.rejects(
    discoverOwnedRepositories('secret', async () => {
      throw new Error('secret');
    }),
    { message: 'GitHub request failed. Check network connectivity and token access.' },
  );
});
