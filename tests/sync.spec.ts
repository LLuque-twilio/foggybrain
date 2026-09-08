import { expect, test, type Page } from '@playwright/test';
import type { Snapshot, SyncPreview, SyncStatus } from '../src/shared';

const target = { repo: 'example/private', branch: 'main', path: 'foggybrain/state.json' };
const status: SyncStatus = {
  configured: true,
  target,
  lastSync: null,
  dirty: true,
  syncing: false,
};
const preview: SyncPreview = {
  previewId: 'preview-1',
  target,
  canApply: true,
  resolution: null,
  conflicts: [],
  validationError: null,
  localChanges: [{ collection: 'tasks', id: 'remote-task', title: 'Imported task', kind: 'added' }],
  remoteChanges: [
    { collection: 'tasks', id: 'local-task', title: 'Local title', kind: 'updated' },
    { collection: 'dependencies', id: 'old-edge', kind: 'deleted' },
  ],
};

async function openSync(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'A little room to think.' })).toBeVisible();
  const navigation = page.getByRole('button', { name: 'Open navigation' });
  if (await navigation.isVisible()) await navigation.click();
  await page.getByRole('button', { name: 'Workspace sync', exact: true }).click();
  return page.getByRole('dialog', { name: 'Workspace sync', exact: true });
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/workspaces', (route) =>
    route.fulfill({
      json: {
        workspaces: [
          { id: 'default', name: 'Personal', type: 'cloud', target, credential: 'dedicated' },
        ],
        defaultWorkspaceId: 'default',
        limit: 3,
      },
    }),
  );
  await page.route('**/api/workspaces/default/state', (route) =>
    route.fulfill({ json: { tasks: [], dependencies: [], references: [], layouts: [] } }),
  );
  await page.route('**/api/workspaces/default/github/status', (route) =>
    route.fulfill({
      json: { configured: false, login: null, lastSync: null, error: null, syncing: false },
    }),
  );
  await page.route('**/api/workspaces/default/github/prs', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/workspaces/default/sync/status', (route) =>
    route.fulfill({ json: status }),
  );
});

test('manual preview requires confirmation and successful apply refreshes the graph', async ({
  page,
}) => {
  const writes: { path: string; body: unknown }[] = [];
  let applied = false;
  let stateReads = 0;
  let syncReads = 0;
  await page.route('**/api/workspaces/default/state', (route) => {
    stateReads++;
    const snapshot: Snapshot = {
      tasks: applied
        ? [
            {
              id: 'remote-task',
              title: 'Imported task',
              description: '',
              kind: 'manual',
              parentId: null,
              manualDone: false,
              prUrl: null,
              prState: 'unknown',
              prCheckedAt: null,
              prError: null,
              createdAt: '2026-09-08T00:00:00Z',
              updatedAt: '2026-09-08T00:00:00Z',
              status: 'available',
              ownSatisfied: false,
              waitingOn: [],
              childrenIds: [],
            },
          ]
        : [],
      dependencies: [],
      references: [],
      layouts: [],
    };
    return route.fulfill({ json: snapshot });
  });
  await page.route('**/api/workspaces/default/sync/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/status')) {
      syncReads++;
      return route.fulfill({ json: status });
    }
    writes.push({ path, body: route.request().postDataJSON() });
    if (path.endsWith('/preview')) return route.fulfill({ json: preview });
    applied = true;
    return route.fulfill({ json: { ...status, dirty: false, lastSync: '2026-09-08T12:00:00Z' } });
  });
  const dialog = await openSync(page);
  await expect(dialog).toContainText('Unsynced local changes');
  expect(writes).toEqual([]);
  await expect.poll(() => stateReads, { timeout: 7000 }).toBeGreaterThan(1);
  expect(syncReads).toBe(1);
  await dialog.getByRole('button', { name: 'Preview sync', exact: true }).click();
  await expect(dialog).toContainText('remote-task');
  await expect(dialog).toContainText('Local title');
  await expect(dialog).toContainText('old-edge');
  await expect(dialog.getByRole('button', { name: 'Apply sync', exact: true })).toBeDisabled();
  expect(writes).toEqual([{ path: '/api/workspaces/default/sync/preview', body: {} }]);
  expect(
    await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBeTruthy();
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Apply sync', exact: true }).click();
  await expect(dialog).toContainText('Workspace sync applied successfully.');
  expect(writes[1]).toEqual({
    path: '/api/workspaces/default/sync/apply',
    body: { previewId: 'preview-1', confirm: true },
  });
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.getByRole('heading', { name: 'Imported task', exact: true })).toBeVisible();
});

for (const resolution of ['local', 'remote'] as const) {
  test(`conflicts regenerate preview with ${resolution} resolution before confirmation`, async ({
    page,
  }) => {
    const bodies: unknown[] = [];
    let applies = 0;
    await page.route('**/api/workspaces/default/sync/preview', (route) => {
      const body = route.request().postDataJSON() as { resolution?: 'local' | 'remote' };
      bodies.push(body);
      return route.fulfill({
        json: {
          ...preview,
          previewId: body.resolution ? 'resolved' : 'conflicted',
          canApply: !!body.resolution,
          resolution: body.resolution ?? null,
          conflicts: [
            {
              path: 'tasks/local-task/title',
              base: 'Original title',
              local: 'Local title',
              remote: 'Remote title',
            },
          ],
        },
      });
    });
    await page.route('**/api/workspaces/default/sync/apply', (route) => {
      applies++;
      expect(route.request().postDataJSON()).toEqual({ previewId: 'resolved', confirm: true });
      return route.fulfill({ json: status });
    });
    const dialog = await openSync(page);
    await dialog.getByRole('button', { name: 'Preview sync', exact: true }).click();
    await expect(dialog).toContainText('Original title');
    await expect(dialog).toContainText('Remote title');
    await expect(dialog.getByRole('button', { name: 'Apply sync', exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: `Use ${resolution} for conflicts` }).click();
    await expect(dialog).toContainText(`Selected conflict resolution: ${resolution}`);
    await expect(
      dialog.getByRole('button', { name: `Use ${resolution} for conflicts` }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(bodies).toEqual([{}, { resolution }]);
    expect(applies).toBe(0);
    await expect(dialog.getByRole('checkbox')).not.toBeChecked();
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: 'Apply sync', exact: true }).click();
    await expect(dialog).toContainText('Workspace sync applied successfully.');
    expect(applies).toBe(1);
  });
}

for (const failure of ['Sync preview is stale; re-preview', 'GitHub state request failed']) {
  test(`${failure} invalidates preview and never retries apply`, async ({ page }) => {
    let applies = 0;
    let previews = 0;
    await page.route('**/api/workspaces/default/sync/preview', (route) => {
      previews++;
      return route.fulfill({ json: { ...preview, previewId: `preview-${previews}` } });
    });
    await page.route('**/api/workspaces/default/sync/apply', (route) => {
      applies++;
      return route.fulfill({
        status: failure.includes('stale') ? 409 : 502,
        json: { error: failure },
      });
    });
    const dialog = await openSync(page);
    await dialog.getByRole('button', { name: 'Preview sync', exact: true }).click();
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: 'Apply sync', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText(failure);
    await expect(dialog.getByRole('alert')).toContainText('an upload may already have committed');
    await expect(dialog.getByRole('button', { name: 'Apply sync', exact: true })).toHaveCount(0);
    expect(applies).toBe(1);
    expect(previews).toBe(1);
    await dialog.getByRole('button', { name: 'Preview sync', exact: true }).click();
    await expect(dialog.getByRole('checkbox')).not.toBeChecked();
    await expect(dialog.getByRole('button', { name: 'Apply sync', exact: true })).toBeDisabled();
    expect(applies).toBe(1);
    expect(previews).toBe(2);
  });
}

test('unconfigured sync gives server-only setup guidance without writes', async ({ page }) => {
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET') writes.push(request.url());
  });
  await page.route('**/api/workspaces/default/sync/status', (route) =>
    route.fulfill({ json: { ...status, configured: false, target: null } }),
  );
  const dialog = await openSync(page);
  await expect(dialog).toContainText('Set up workspace sync');
  for (const text of ['FOGGY_SYNC_TOKEN', 'Contents read/write'])
    await expect(dialog).toContainText(text);
  await expect(dialog.getByRole('button', { name: 'Preview sync', exact: true })).toBeDisabled();
  expect(writes).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
});

test('validation and status errors remain inside the dialog', async ({ page }) => {
  await page.route('**/api/workspaces/default/sync/status', (route) =>
    route.fulfill({ status: 503, json: { error: 'Sync configuration is invalid' } }),
  );
  const dialog = await openSync(page);
  await expect(dialog.getByRole('alert')).toContainText('Sync configuration is invalid');
  await page.route('**/api/workspaces/default/sync/status', (route) =>
    route.fulfill({ json: status }),
  );
  await dialog.getByRole('button', { name: 'Refresh status' }).click();
  await page.route('**/api/workspaces/default/sync/preview', (route) =>
    route.fulfill({
      json: { ...preview, canApply: false, validationError: 'No common sync baseline.' },
    }),
  );
  await dialog.getByRole('button', { name: 'Preview sync', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('No common sync baseline.');
  await expect(dialog.getByRole('button', { name: 'Apply sync', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
});
