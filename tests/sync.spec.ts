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
  mode: 'merge',
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
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveAccessibleName('Workspace sync');
  return dialog;
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
    route.fulfill({
      json: {
        tasks: [],
        dependencies: [],
        references: [],
        tags: [],
        layouts: [],
        preferences: { hideCompleted: true },
      },
    }),
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

for (const mode of ['merge', 'revert'] as const) {
  test(`${mode} preview requires confirmation and successful apply refreshes the graph`, async ({
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
                prMergeStatus: 'unknown',
                prCheckedAt: null,
                prError: null,
                tagIds: [],
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
        tags: [],
        layouts: [],
        preferences: { hideCompleted: true },
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
      if (path.endsWith('/preview')) return route.fulfill({ json: { ...preview, mode } });
      applied = true;
      return route.fulfill({ json: { ...status, dirty: false, lastSync: '2026-09-08T12:00:00Z' } });
    });
    const dialog = await openSync(page);
    await expect(dialog).toContainText('Unsynced local changes');
    expect(writes).toEqual([]);
    await expect.poll(() => stateReads, { timeout: 7000 }).toBeGreaterThan(1);
    expect(syncReads).toBe(1);
    const entry = mode === 'revert' ? 'Reset to origin' : 'Push to origin';
    const apply = mode === 'revert' ? 'Confirm reset to origin' : 'Apply sync';
    await dialog.getByRole('button', { name: entry, exact: true }).click();
    await expect(dialog).toHaveCount(1);
    await expect(dialog).toHaveAccessibleName(entry);
    await expect(
      dialog.getByRole('heading', {
        name: mode === 'revert' ? 'Review reset to origin' : 'Review push to origin',
        level: 3,
      }),
    ).toBeVisible();
    for (const name of ['Push to origin', 'Reset to origin', 'Refresh status'])
      await expect(dialog.getByRole('button', { name, exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Back to sync options' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Refresh preview' })).toBeVisible();
    await expect(
      dialog.getByRole('button', {
        name: mode === 'revert' ? 'Apply sync' : 'Confirm reset to origin',
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(dialog).toContainText('remote-task');
    if (mode === 'merge') {
      await expect(dialog).toContainText('Local title');
      await expect(dialog).toContainText('old-edge');
    } else {
      await expect(dialog).toContainText('discards unsynced local tasks and relationships');
      await expect(dialog).toContainText('automatic local backup');
      await expect(dialog).toContainText('Revert never writes to GitHub');
      await expect(dialog).toContainText(`${target.repo} / ${target.branch} / ${target.path}`);
      await expect(dialog.getByRole('button', { name: /for conflicts/ })).toHaveCount(0);
      await expect(dialog.getByRole('region', { name: 'Changes to remote state' })).toHaveCount(0);
    }
    await expect(dialog.getByRole('button', { name: apply, exact: true })).toBeDisabled();
    expect(writes).toEqual([
      { path: '/api/workspaces/default/sync/preview', body: mode === 'revert' ? { mode } : {} },
    ]);
    expect(
      await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBeTruthy();
    await dialog.getByRole('checkbox').check();
    if (mode === 'revert')
      await expect(dialog.getByRole('checkbox')).toHaveAccessibleName(
        /discarding unsynced local changes/,
      );
    await dialog.getByRole('button', { name: apply, exact: true }).click();
    await expect(dialog).toContainText(
      mode === 'revert'
        ? 'Workspace reverted to origin successfully.'
        : 'Workspace sync applied successfully.',
    );
    await expect(dialog).toHaveAccessibleName(entry);
    await expect(dialog.getByRole('button', { name: 'Back to sync options' })).toBeVisible();
    expect(writes[1]).toEqual({
      path: '/api/workspaces/default/sync/apply',
      body: { previewId: 'preview-1', confirm: true },
    });
    await dialog.getByRole('button', { name: 'Close dialog' }).click();
    await expect(page.getByRole('heading', { name: 'Imported task', exact: true })).toBeVisible();
  });
}

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
    await dialog.getByRole('button', { name: 'Push to origin', exact: true }).click();
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

for (const mode of ['merge', 'revert'] as const) {
  for (const failure of ['Sync preview is stale; re-preview', 'GitHub state request failed']) {
    test(`${mode}: ${failure} invalidates preview and never retries apply`, async ({ page }) => {
      let applies = 0;
      let previews = 0;
      await page.route('**/api/workspaces/default/sync/preview', (route) => {
        previews++;
        return route.fulfill({ json: { ...preview, mode, previewId: `preview-${previews}` } });
      });
      await page.route('**/api/workspaces/default/sync/apply', (route) => {
        applies++;
        return route.fulfill({
          status: failure.includes('stale') ? 409 : 502,
          json: { error: failure },
        });
      });
      const dialog = await openSync(page);
      const entry = mode === 'revert' ? 'Reset to origin' : 'Push to origin';
      const apply = mode === 'revert' ? 'Confirm reset to origin' : 'Apply sync';
      await dialog.getByRole('button', { name: entry, exact: true }).click();
      await dialog.getByRole('checkbox').check();
      await dialog.getByRole('button', { name: apply, exact: true }).click();
      await expect(dialog.getByRole('alert')).toContainText(failure);
      await expect(dialog.getByRole('alert')).toContainText(
        mode === 'revert'
          ? 'local state may already have been replaced'
          : 'an upload may already have committed',
      );
      await expect(dialog.getByRole('button', { name: apply, exact: true })).toHaveCount(0);
      expect(applies).toBe(1);
      expect(previews).toBe(1);
      await expect(dialog).toHaveAccessibleName(entry);
      await expect(dialog.getByRole('button', { name: entry, exact: true })).toHaveCount(0);
      await dialog.getByRole('button', { name: 'Refresh preview' }).click();
      await expect(dialog.getByRole('checkbox')).not.toBeChecked();
      await expect(dialog.getByRole('button', { name: apply, exact: true })).toBeDisabled();
      expect(applies).toBe(1);
      expect(previews).toBe(2);
    });
  }
}

test('revert requests fresh previews, clears merge confirmation, and cancels without apply', async ({
  page,
}) => {
  const bodies: unknown[] = [];
  let applies = 0;
  await page.route('**/api/workspaces/default/sync/preview', (route) => {
    const body = route.request().postDataJSON();
    bodies.push(body);
    return route.fulfill({
      json: {
        ...preview,
        mode: body.mode ?? 'merge',
        previewId: `preview-${bodies.length}`,
        localChanges: [
          { collection: 'tasks', id: 'local-only', title: 'Unsynced task', kind: 'deleted' },
          { collection: 'dependencies', id: 'local-edge', kind: 'deleted' },
          { collection: 'references', id: 'local-reference', kind: 'deleted' },
        ],
      },
    });
  });
  await page.route('**/api/workspaces/default/sync/apply', (route) => {
    applies++;
    return route.fulfill({ json: status });
  });
  const dialog = await openSync(page);
  await dialog.getByRole('button', { name: 'Push to origin', exact: true }).click();
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Back to sync options' }).click();
  await expect(dialog).toHaveAccessibleName('Workspace sync');
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Apply sync', exact: true })).toHaveCount(0);
  await expect(
    dialog.getByRole('heading', { level: 3, name: 'Review push to origin' }),
  ).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Refresh status' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Refresh preview' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Reset to origin', exact: true }).click();
  await expect(dialog).toHaveAccessibleName('Reset to origin');
  await expect(dialog.getByRole('checkbox')).not.toBeChecked();
  for (const text of ['Unsynced task', 'local-edge', 'local-reference'])
    await expect(dialog).toContainText(text);
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Refresh preview' }).click();
  await expect(dialog.getByRole('checkbox')).not.toBeChecked();
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  const reopened = await openSync(page);
  await expect(reopened.getByRole('checkbox')).toHaveCount(0);
  await reopened.getByRole('button', { name: 'Reset to origin', exact: true }).click();
  await expect(reopened.getByRole('checkbox')).not.toBeChecked();
  expect(bodies).toEqual([{}, { mode: 'revert' }, { mode: 'revert' }, { mode: 'revert' }]);
  expect(applies).toBe(0);
});

for (const failure of [
  'Origin file does not exist',
  'Pending upload outcome requires reconciliation',
]) {
  test(`revert preview failure clears prior confirmation: ${failure}`, async ({ page }) => {
    let previews = 0;
    let applies = 0;
    await page.route('**/api/workspaces/default/sync/preview', (route) => {
      expect(route.request().postDataJSON()).toEqual({ mode: 'revert' });
      previews++;
      return previews === 2
        ? route.fulfill({ status: 409, json: { error: failure } })
        : route.fulfill({ json: { ...preview, mode: 'revert', previewId: `revert-${previews}` } });
    });
    await page.route('**/api/workspaces/default/sync/apply', (route) => {
      applies++;
      return route.fulfill({ json: status });
    });
    const dialog = await openSync(page);
    await dialog.getByRole('button', { name: 'Reset to origin', exact: true }).click();
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: 'Refresh preview' }).click();
    await expect(dialog.getByRole('alert')).toContainText(failure);
    await expect(dialog).toHaveAccessibleName('Reset to origin');
    await expect(dialog.getByRole('checkbox')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Confirm reset to origin' })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Refresh preview' }).click();
    await expect(dialog.getByRole('checkbox')).not.toBeChecked();
    await expect(dialog.getByRole('button', { name: 'Confirm reset to origin' })).toBeDisabled();
    expect(applies).toBe(0);
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
  await expect(dialog.getByRole('button', { name: 'Push to origin', exact: true })).toBeDisabled();
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
  await dialog.getByRole('button', { name: 'Push to origin', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('No common sync baseline.');
  await expect(dialog.getByRole('button', { name: 'Apply sync', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
});

for (const mode of ['merge', 'revert'] as const) {
  for (const canApply of [true, false]) {
    test(`${mode} empty preview with canApply=${canApply} has no confirmation or apply`, async ({
      page,
    }) => {
      const bodies: unknown[] = [];
      let applies = 0;
      await page.route('**/api/workspaces/default/sync/preview', (route) => {
        bodies.push(route.request().postDataJSON());
        return route.fulfill({
          json: {
            ...preview,
            mode,
            canApply,
            localChanges: [],
            remoteChanges: [],
            validationError: canApply ? null : 'No common sync baseline.',
          } satisfies SyncPreview,
        });
      });
      await page.route('**/api/workspaces/default/sync/apply', (route) => {
        applies++;
        return route.fulfill({ json: status });
      });
      const dialog = await openSync(page);
      const entry = mode === 'revert' ? 'Reset to origin' : 'Push to origin';
      await dialog.getByRole('button', { name: entry, exact: true }).click();
      await expect(dialog).toHaveAccessibleName(entry);
      await expect(
        dialog.getByRole('heading', {
          name: mode === 'revert' ? 'Review reset to origin' : 'Review push to origin',
          level: 3,
        }),
      ).toBeVisible();
      if (canApply) await expect(dialog).toContainText('Already up to date. No changes to apply.');
      else {
        await expect(dialog.getByRole('alert')).toContainText('No common sync baseline.');
        await expect(dialog).not.toContainText('Already up to date. No changes to apply.');
      }
      await expect(dialog.getByRole('checkbox')).toHaveCount(0);
      for (const name of [
        'Apply sync',
        'Confirm reset to origin',
        'Push to origin',
        'Reset to origin',
        'Refresh status',
      ])
        await expect(dialog.getByRole('button', { name, exact: true })).toHaveCount(0);
      await dialog.getByRole('button', { name: 'Refresh preview' }).click();
      await expect.poll(() => bodies.length).toBe(2);
      expect(bodies).toEqual(mode === 'revert' ? [{ mode }, { mode }] : [{}, {}]);
      await dialog.getByRole('button', { name: 'Back to sync options' }).click();
      await expect(dialog).toHaveAccessibleName('Workspace sync');
      await expect(dialog.getByRole('button', { name: entry, exact: true })).toBeEnabled();
      expect(applies).toBe(0);
    });
  }

  test(`${mode} changes that cannot apply retain a disabled apply button`, async ({ page }) => {
    await page.route('**/api/workspaces/default/sync/preview', (route) =>
      route.fulfill({
        json: { ...preview, mode, canApply: false, validationError: 'Invalid graph.' },
      }),
    );
    const dialog = await openSync(page);
    await dialog
      .getByRole('button', {
        name: mode === 'revert' ? 'Reset to origin' : 'Push to origin',
        exact: true,
      })
      .click();
    await expect(dialog.getByRole('alert')).toContainText('Invalid graph.');
    await expect(
      dialog.getByRole('button', {
        name: mode === 'revert' ? 'Confirm reset to origin' : 'Apply sync',
        exact: true,
      }),
    ).toBeDisabled();
    await expect(dialog.getByRole('checkbox')).toHaveCount(0);
    await expect(dialog).not.toContainText('Already up to date. No changes to apply.');
  });
}

for (const side of ['localChanges', 'remoteChanges'] as const) {
  test(`push with only ${side} still requires confirmation and can apply`, async ({ page }) => {
    let applies = 0;
    await page.route('**/api/workspaces/default/sync/preview', (route) =>
      route.fulfill({
        json: { ...preview, localChanges: [], remoteChanges: [], [side]: preview[side] },
      }),
    );
    await page.route('**/api/workspaces/default/sync/apply', (route) => {
      applies++;
      expect(route.request().postDataJSON()).toEqual({
        previewId: preview.previewId,
        confirm: true,
      });
      return route.fulfill({ json: status });
    });
    const dialog = await openSync(page);
    await dialog.getByRole('button', { name: 'Push to origin', exact: true }).click();
    const apply = dialog.getByRole('button', { name: 'Apply sync', exact: true });
    await expect(apply).toBeDisabled();
    await expect(dialog).not.toContainText('Already up to date. No changes to apply.');
    await dialog.getByRole('checkbox').check();
    await expect(apply).toBeEnabled();
    expect(applies).toBe(0);
    await apply.click();
    await expect(dialog).toContainText('Workspace sync applied successfully.');
    await expect(dialog).toHaveAccessibleName('Push to origin');
    expect(applies).toBe(1);
  });
}

test('sync actions and change badges have distinct colors', async ({ page }) => {
  await page.route('**/api/workspaces/default/sync/preview', (route) =>
    route.fulfill({ json: preview }),
  );
  const dialog = await openSync(page);
  const push = dialog.getByRole('button', { name: 'Push to origin', exact: true });
  const reset = dialog.getByRole('button', { name: 'Reset to origin', exact: true });
  await expect(push).toBeEnabled();
  await expect(reset).toBeEnabled();
  const pushBackground = await push.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  await expect(reset).not.toHaveCSS('background-color', pushBackground);
  await push.click();
  const colors: string[] = [];
  for (const kind of ['added', 'updated', 'deleted']) {
    const badge = dialog.locator(`.sync-change-${kind}`);
    await expect(badge).toHaveCount(1);
    await expect(badge).toBeVisible();
    await expect(badge).toContainText(kind);
    colors.push(await badge.evaluate((element) => getComputedStyle(element).color));
  }
  expect(new Set(colors).size).toBe(3);
});
