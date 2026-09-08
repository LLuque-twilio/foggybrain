import { expect, test, type Page } from '@playwright/test';
import type {
  CreateWorkspaceInput,
  SyncPreview,
  TaskView,
  Workspace,
  WorkspaceList,
  WorkspaceRemovalPreview,
} from '../src/shared';

async function selectCloudTarget(page: Page) {
  const dialog = page.getByRole('dialog');
  for (const [label, value] of [
    ['Repository', 'example/private'],
    ['Branch', 'main'],
    ['State file path', 'foggybrain/state.json'],
  ]) {
    await dialog.getByLabel(label, { exact: true }).fill(value);
    await dialog.getByRole('option', { name: value, exact: true }).click();
  }
}

async function navigation(page: Page) {
  await expect(page.getByRole('combobox', { name: 'Workspace', exact: true })).toBeAttached();
  const open = page.getByRole('button', { name: 'Open navigation' });
  if (
    (await open.isVisible()) &&
    !(await page.getByRole('button', { name: 'Close navigation' }).count())
  )
    await open.click();
}

async function removalSetup(page: Page, count = 3) {
  const list: WorkspaceList = {
    workspaces: ['default', 'second', 'third'].slice(0, count).map((id) => ({
      id,
      name: id,
      type: 'local',
      target: null,
      credential: null,
    })),
    defaultWorkspaceId: count ? 'default' : null,
    limit: 3,
  };
  if (count)
    Object.assign(list.workspaces[0], {
      type: 'cloud',
      credential: 'dedicated',
      target: { repo: 'example/private', branch: 'main', path: 'foggybrain/state.json' },
    });
  const reads: string[] = [];
  const deletes: { id: string; body: unknown }[] = [];
  await page.route('**/api/workspaces', (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: list });
    expect(route.request().method()).toBe('POST');
    const input = route.request().postDataJSON() as CreateWorkspaceInput;
    const workspace: Workspace = {
      ...input,
      id: 'created-workspace',
      target: input.target ?? null,
      credential: input.credential ?? null,
    };
    list.workspaces.push(workspace);
    list.defaultWorkspaceId ??= workspace.id;
    return route.fulfill({ status: 201, json: workspace });
  });
  await page.route('**/api/workspaces/*/sync/status', (route) => {
    const workspace = list.workspaces.find((entry) =>
      route.request().url().includes(`/${entry.id}/`),
    )!;
    return route.fulfill({
      json: {
        configured: workspace.type === 'cloud',
        target: workspace.target,
        lastSync: null,
        dirty: false,
        syncing: false,
      },
    });
  });
  await page.route('**/api/workspaces/*/sync/preview', (route) =>
    route.fulfill({
      json: {
        previewId: 'empty-cloud-preview',
        target: list.workspaces[0].target!,
        localChanges: [],
        remoteChanges: [],
        conflicts: [],
        validationError: null,
        canApply: true,
        resolution: null,
      } satisfies SyncPreview,
    }),
  );
  await page.route('**/api/workspaces/*/removal-preview', (route) => {
    const id = new URL(route.request().url()).pathname.split('/')[3];
    reads.push(id);
    return route.fulfill({
      json: {
        workspace: list.workspaces.find((workspace) => workspace.id === id)!,
        taskCount: 7,
        dependencyCount: 2,
        referenceCount: 1,
        dirty: true,
        canRemove: true,
        reason: null,
        revision: `revision-${reads.length}`,
      } satisfies WorkspaceRemovalPreview,
    });
  });
  await page.route('**/api/workspaces/*?confirm=true', (route) => {
    expect(route.request().method()).toBe('DELETE');
    const id = new URL(route.request().url()).pathname.split('/')[3];
    deletes.push({ id, body: route.request().postDataJSON() });
    list.workspaces = list.workspaces.filter((workspace) => workspace.id !== id);
    list.defaultWorkspaceId = list.workspaces[0]?.id ?? null;
    return route.fulfill({ json: list });
  });
  await page.goto(count ? '/?other=kept&workspace=default#/settings' : '/');
  const settings = page.getByRole('region', { name: 'Workspace settings' });
  const open = () =>
    settings.getByRole('button', { name: 'Remove workspace', exact: true }).click();
  return { list, reads, deletes, settings, open, dialog: page.getByRole('dialog') };
}

test('removal preview is read-only, confirmation required, cancel and backdrop preserve data', async ({
  page,
}) => {
  const { open, dialog, deletes, list } = await removalSetup(page);
  for (const cancel of ['button', 'backdrop']) {
    await open();
    await expect(dialog).toContainText('7 tasks, 2 dependencies, 1 references');
    await expect(dialog).toContainText('Unsynced local changes will be permanently lost');
    await expect(dialog).toContainText('example/private');
    await expect(dialog).toContainText('Nothing is deleted or published remotely');
    await expect(dialog.getByRole('button', { name: 'Remove permanently' })).toBeDisabled();
    await dialog.getByRole('checkbox').check();
    await expect(dialog.getByRole('button', { name: 'Remove permanently' })).toBeEnabled();
    if (cancel === 'button')
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    else await page.mouse.click(1, 1);
    await expect(dialog).toHaveCount(0);
  }
  expect(deletes).toEqual([]);
  expect(list.workspaces).toHaveLength(3);
});

test('removal selects returned default survivor, reopens capacity, and removed links never fall back', async ({
  page,
}) => {
  const { open, dialog, deletes, settings } = await removalSetup(page);
  await expect(settings.getByRole('button', { name: 'Add workspace', exact: true })).toBeDisabled();
  await open();
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Remove permanently' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/other=kept&workspace=second#\/settings$/);
  await expect(settings.locator('dd').first()).toHaveText('second');
  await expect(settings.getByRole('button', { name: 'Add workspace', exact: true })).toBeEnabled();
  expect(deletes).toEqual([{ id: 'default', body: { revision: 'revision-1' } }]);
  await page.goBack();
  await expect(page.getByRole('alert')).toContainText('This workspace is not available');
  await expect(page.getByRole('combobox', { name: 'Workspace', exact: true })).toHaveCount(0);
});

test('last workspace removal opens empty screen, clears selection and route, and survives reload', async ({
  page,
}) => {
  const { open, dialog, deletes } = await removalSetup(page, 1);
  await open();
  await expect(dialog.getByRole('checkbox')).toBeEnabled();
  await expect(dialog.getByRole('button', { name: 'Remove permanently' })).toBeDisabled();
  await page.evaluate(() =>
    window.history.replaceState(null, '', '?other=kept&workspace=default#/tasks/old-task'),
  );
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Remove permanently' }).click();
  await expect(page.getByRole('heading', { name: 'Add or connect workspace' })).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\?other=kept#\/$/);
  expect(deletes).toEqual([{ id: 'default', body: { revision: 'revision-1' } }]);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Add or connect workspace' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

for (const type of ['local', 'cloud'] as const) {
  test(`empty startup creates ${type} workspace without an absent identity or unscoped graph`, async ({
    page,
  }) => {
    const requests: { method: string; path: string }[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith('/api/')) requests.push({ method: request.method(), path });
    });
    const { list } = await removalSetup(page, 0);
    await expect(page.getByRole('heading', { name: 'Add or connect workspace' })).toBeVisible();
    expect(requests.every((request) => request.path === '/api/workspaces')).toBe(true);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page
      .getByRole('button', {
        name: type === 'local' ? 'Add workspace' : 'Connect to cloud',
        exact: true,
      })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Add workspace', exact: true });
    await expect(dialog.getByLabel('Storage type')).toHaveValue(type);
    await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('');
    await dialog.getByLabel('Name', { exact: true }).fill('Fresh workspace');
    if (type === 'cloud') await selectCloudTarget(page);
    await dialog.getByRole('button', { name: 'Save workspace' }).click();
    await expect(page).toHaveURL(/workspace=created-workspace/);
    if (type === 'cloud') {
      await expect(page.getByRole('heading', { name: 'Review sync preview' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Apply sync' })).toBeDisabled();
    } else
      await expect(page.getByRole('heading', { name: 'A little room to think.' })).toBeVisible();
    expect(list.defaultWorkspaceId).toBe('created-workspace');
    expect(requests.filter((request) => request.method !== 'GET')).toEqual([
      { method: 'POST', path: '/api/workspaces' },
      ...(type === 'cloud'
        ? [{ method: 'POST', path: '/api/workspaces/created-workspace/sync/preview' }]
        : []),
    ]);
    expect(
      requests
        .filter((request) => request.path.endsWith('/state'))
        .every((request) => request.path === '/api/workspaces/created-workspace/state'),
    ).toBe(true);
    await page.goto('/');
    await navigation(page);
    await expect(page.getByRole('combobox', { name: 'Workspace', exact: true })).toHaveValue(
      'created-workspace',
    );
  });
}

test('external default removal does not silently switch an unscoped tab', async ({ page }) => {
  const { list } = await removalSetup(page);
  await page.goto('/#/settings');
  await expect(
    page.getByRole('region', { name: 'Workspace settings' }).locator('dd').first(),
  ).toHaveText('default');
  list.workspaces = list.workspaces.slice(1);
  list.defaultWorkspaceId = 'second';
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('alert')).toContainText('This workspace is not available');
  await expect(page.getByRole('combobox', { name: 'Workspace', exact: true })).toHaveCount(0);
});

test('cancelled pending removal preview cannot populate a reopened dialog', async ({ page }) => {
  const { open, dialog, deletes } = await removalSetup(page);
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  await page.route('**/api/workspaces/default/removal-preview', async (route) => {
    if (started) return route.fulfill({ status: 503, json: { error: 'Preview unavailable' } });
    started = true;
    await wait;
    await route.fallback();
  });
  await open();
  await expect.poll(() => started).toBe(true);
  await expect(dialog.getByRole('button', { name: 'Remove permanently' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await open();
  await expect(dialog.getByRole('alert')).toContainText('Preview unavailable');
  const response = page.waitForResponse('**/api/workspaces/default/removal-preview');
  release();
  await (await response).finished();
  await expect(dialog.getByRole('checkbox')).toBeDisabled();
  await expect(dialog).not.toContainText('7 tasks');
  expect(deletes).toEqual([]);
});

test('stale removal requires a fresh preview and renewed confirmation without changing data', async ({
  page,
}) => {
  const { open, dialog, reads, deletes, list } = await removalSetup(page);
  let failures = 0;
  await page.route('**/api/workspaces/default?confirm=true', (route) => {
    failures++;
    return route.fulfill({ status: 409, json: { error: 'Workspace changed since preview.' } });
  });
  await open();
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Remove permanently' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Review a new preview');
  await expect(dialog.getByRole('button', { name: 'Remove permanently' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Review new preview' }).click();
  await expect(dialog.getByRole('checkbox')).toBeEnabled();
  await expect(dialog.getByRole('checkbox')).not.toBeChecked();
  await expect(dialog.getByRole('button', { name: 'Remove permanently' })).toBeDisabled();
  expect(reads).toEqual(['default', 'default']);
  expect(failures).toBe(1);
  expect(deletes).toEqual([]);
  expect(list.workspaces).toHaveLength(3);
});

test('uncertain removal refreshes the list and does not fall back to a removed ID', async ({
  page,
}) => {
  const { open, dialog, list } = await removalSetup(page);
  await page.route('**/api/workspaces/default?confirm=true', (route) => {
    list.workspaces = list.workspaces.slice(1);
    list.defaultWorkspaceId = 'second';
    return route.abort('failed');
  });
  await open();
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Remove permanently' }).click();
  await expect(page.getByRole('alert')).toContainText('This workspace is not available');
  await expect(page).toHaveURL(/workspace=default/);
  await page.getByRole('button', { name: 'second', exact: true }).click();
  await expect(page).toHaveURL(/workspace=second/);
});

test('pending removal prevents duplicate writes and ignores navigation after workspace switching', async ({
  page,
}) => {
  const { open, dialog, deletes } = await removalSetup(page);
  await navigation(page);
  await page.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption('second');
  await navigation(page);
  await page.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption('default');
  if (await page.getByRole('button', { name: 'Close navigation' }).isVisible())
    await page.getByRole('button', { name: 'Close navigation' }).click();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  await page.route('**/api/workspaces/default?confirm=true', async (route) => {
    started = true;
    await wait;
    await route.fallback();
  });
  await open();
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Remove permanently' }).click();
  await expect.poll(() => started).toBe(true);
  await expect(dialog.getByRole('button', { name: 'Remove permanently' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/workspace=second/);
  const response = page.waitForResponse('**/api/workspaces/default?confirm=true');
  release();
  await (await response).finished();
  await expect(page).toHaveURL(/workspace=second/);
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => deletes.length).toBe(1);
});

test.beforeEach(async ({ page }) => {
  const workspaces: Workspace[] = [
    { id: 'default', name: 'Personal', type: 'local', target: null, credential: null },
  ];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/workspaces/branches')
      return route.fulfill({ json: { branches: ['main', 'trunk', 'custom'] } });
    if (path === '/api/workspaces/files')
      return route.fulfill({ json: { paths: ['foggybrain/state.json', 'other.json'] } });
    if (path === '/api/workspaces/repositories')
      return route.fulfill({
        json: {
          login: 'example',
          repositories: [
            { id: 1, fullName: 'example/private', defaultBranch: 'trunk' },
            { id: 2, fullName: 'example/other', defaultBranch: 'main' },
          ],
        },
      });
    if (path === '/api/workspaces') {
      if (request.method() === 'GET')
        return route.fulfill({ json: { workspaces, defaultWorkspaceId: 'default', limit: 3 } });
      const input = request.postDataJSON() as CreateWorkspaceInput;
      const workspace: Workspace = {
        ...input,
        id: `space-${workspaces.length}`,
        target: input.target ?? null,
        credential: input.credential ?? null,
      };
      workspaces.push(workspace);
      return route.fulfill({ status: 201, json: workspace });
    }
    const match = path.match(/^\/api\/workspaces\/([^/]+)(.*)$/);
    if (!match)
      return route.fulfill({ status: 500, json: { error: 'Unscoped request forbidden' } });
    const workspace = workspaces.find((entry) => entry.id === match[1])!;
    const suffix = match[2];
    if (!suffix && request.method() === 'PATCH') {
      const input = request.postDataJSON() as CreateWorkspaceInput;
      if (input.target?.branch === 'invalid..branch')
        return route.fulfill({ status: 400, json: { error: 'Invalid sync branch' } });
      Object.assign(workspace, input);
      return route.fulfill({ json: workspace });
    }
    if (suffix === '/state')
      return route.fulfill({ json: { tasks: [], dependencies: [], references: [], layouts: [] } });
    if (suffix === '/github/prs') return route.fulfill({ json: [] });
    if (suffix === '/github/status')
      return route.fulfill({
        json: { configured: false, login: null, lastSync: null, error: null, syncing: false },
      });
    if (suffix === '/sync/status')
      return route.fulfill({
        json: {
          configured: workspace.type === 'cloud',
          target: workspace.target,
          lastSync: null,
          dirty: false,
          syncing: false,
        },
      });
    if (suffix === '/sync/preview') {
      const preview: SyncPreview = {
        previewId: `preview-${workspace.id}`,
        target: workspace.target!,
        localChanges: [],
        remoteChanges: [],
        conflicts: [],
        validationError: null,
        canApply: true,
        resolution: null,
      };
      return route.fulfill({ json: preview });
    }
    return route.fulfill({ status: 500, json: { error: `Unexpected request: ${path}` } });
  });
});

test('add local and cloud, enforce cap, and retain tab-local workspace deep links', async ({
  page,
  context,
}) => {
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET') writes.push(new URL(request.url()).pathname);
  });
  await page.goto('/?other=kept#/map');
  await navigation(page);
  await page.getByRole('button', { name: 'Add workspace', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('Side project');
  await dialog.getByRole('button', { name: 'Save workspace' }).click();
  await expect(page).toHaveURL(/other=kept&workspace=space-1#\/map$/);
  await navigation(page);
  await expect(page.getByRole('combobox', { name: 'Workspace', exact: true })).toHaveValue(
    'space-1',
  );
  await page.getByRole('button', { name: 'Add workspace', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('Shared brain');
  await dialog.getByLabel('Storage type').selectOption('cloud');
  await dialog.getByRole('combobox', { name: 'Repository', exact: true }).fill('PRIVATE');
  await expect(dialog.getByRole('listbox').getByRole('option')).toHaveCount(1);
  await dialog.getByRole('option', { name: 'example/private', exact: true }).click();
  await expect(dialog.getByLabel('Branch', { exact: true })).toHaveValue('');
  await expect(dialog.getByLabel('State file path')).toBeDisabled();
  await dialog.getByLabel('Branch', { exact: true }).fill('trunk');
  await dialog.getByRole('option', { name: 'trunk', exact: true }).click();
  await dialog.getByLabel('State file path').fill('foggybrain/state.json');
  await dialog.getByRole('option', { name: 'foggybrain/state.json', exact: true }).click();
  await expect(dialog.getByLabel('Server credential')).toHaveValue('dedicated');
  await expect(dialog).toContainText('Saving opens a sync preview, not an automatic apply');
  await dialog.getByRole('button', { name: 'Save workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Review sync preview' })).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await navigation(page);
  await expect(page.getByRole('button', { name: 'Add workspace', exact: true })).toBeDisabled();
  await expect(page.getByRole('combobox', { name: 'Workspace', exact: true })).toContainText(
    'Shared brain (Cloud)',
  );
  await expect(page.getByRole('button', { name: 'Connect to cloud' })).toHaveCount(0);
  expect(writes).toEqual([
    '/api/workspaces',
    '/api/workspaces',
    '/api/workspaces/space-2/sync/preview',
  ]);
  await page.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption('default');
  await expect(page).toHaveURL(/workspace=default#\/map$/);
  await page.goBack();
  await navigation(page);
  await expect(page.getByRole('combobox', { name: 'Workspace', exact: true })).toHaveValue(
    'space-2',
  );
  const other = await context.newPage();
  // A fresh tab has no shared selection persisted in browser storage.
  await other.route('**/api/**', (route) =>
    route.fulfill({ status: 503, json: { error: 'Offline' } }),
  );
  await other.goto('/');
  expect(new URL(other.url()).searchParams.has('workspace')).toBe(false);
  await expect(other.getByRole('alert')).toContainText('Offline');
});

test('cloud fields visually distinguish disabled controls, placeholders, and entered text', async ({
  page,
}) => {
  await page.goto('/');
  await navigation(page);
  await page.getByRole('button', { name: 'Connect to cloud' }).click();
  const dialog = page.getByRole('dialog');
  const repository = dialog.getByLabel('Repository', { exact: true });
  const branch = dialog.getByLabel('Branch', { exact: true });
  const path = dialog.getByLabel('State file path');
  await expect(repository).toBeEnabled();
  const enabledBackground = await repository.evaluate(
    (input) => getComputedStyle(input).backgroundColor,
  );
  for (const field of [branch, path]) {
    await expect(field).toBeDisabled();
    await expect(field).not.toHaveCSS('background-color', enabledBackground);
    await expect(field).toHaveCSS('border-top-style', 'dashed');
    await expect(field).toHaveCSS('cursor', 'not-allowed');
  }
  const placeholder = await repository.evaluate((input) => {
    const style = getComputedStyle(input, '::placeholder');
    return { color: style.color, fontStyle: style.fontStyle, opacity: style.opacity };
  });
  expect(placeholder.fontStyle).toBe('italic');
  expect(placeholder.opacity).toBe('1');
  await repository.fill('private');
  await expect(repository).not.toHaveCSS('color', placeholder.color);
  await expect(repository).toHaveCSS('font-style', 'normal');
  await dialog.getByRole('option', { name: 'example/private', exact: true }).click();
  await expect(branch).toBeEnabled();
  await expect(branch).toHaveCSS('background-color', enabledBackground);
  await expect(branch).toHaveCSS('border-top-style', 'solid');
  await expect(branch).not.toHaveCSS('cursor', 'not-allowed');
  await branch.fill('main');
  await dialog.getByRole('option', { name: 'main', exact: true }).click();
  await expect(path).toBeEnabled();
  await expect(path).toHaveCSS('background-color', enabledBackground);
  await expect(path).toHaveCSS('border-top-style', 'solid');
});

test('rename and connect preserve identity, validate configuration, and require explicit GitHub reuse', async ({
  page,
}) => {
  const patches: unknown[] = [];
  page.on('request', (request) => {
    if (request.method() === 'PATCH') patches.push(request.postDataJSON());
  });
  await page.goto('/');
  await navigation(page);
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('Research');
  await dialog.getByRole('button', { name: 'Save workspace' }).click();
  await expect(page.getByRole('combobox', { name: 'Workspace', exact: true })).toContainText(
    'Research (Local)',
  );
  await page.getByRole('button', { name: 'About local storage' }).click();
  await expect(page.getByRole('dialog')).toContainText('This is a local workspace');
  await expect(page.getByRole('dialog')).not.toContainText('Unsynced local changes');
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await navigation(page);
  await page.getByRole('button', { name: 'Connect to cloud' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Repository', { exact: true }).fill('not-a-repo');
  await expect(dialog.getByRole('status')).toContainText('No repositories match');
  await expect(dialog.getByRole('button', { name: 'Save workspace' })).toBeDisabled();
  expect(patches).toEqual([{ name: 'Research' }]);
  await dialog.getByLabel('Repository', { exact: true }).fill('private');
  await dialog.getByRole('option', { name: 'example/private', exact: true }).click();
  await dialog.getByLabel('Branch', { exact: true }).fill('invalid..branch');
  await expect(dialog.getByRole('button', { name: 'Save workspace' })).toBeDisabled();
  await expect(dialog.getByLabel('State file path')).toBeDisabled();
  await dialog.getByLabel('Branch', { exact: true }).fill('main');
  await dialog.getByLabel('Server credential').selectOption('github');
  await expect(dialog.getByLabel('Repository', { exact: true })).toHaveValue('');
  await expect(dialog.getByRole('button', { name: 'Save workspace' })).toBeDisabled();
  await dialog.getByLabel('Repository', { exact: true }).fill('private');
  await dialog.getByRole('option', { name: 'example/private', exact: true }).click();
  await expect(dialog.getByLabel('Branch', { exact: true })).toHaveValue('');
  await dialog.getByLabel('Branch', { exact: true }).fill('main');
  await dialog.getByRole('option', { name: 'main', exact: true }).click();
  await dialog.getByLabel('State file path').fill('foggybrain/state.json');
  await dialog.getByRole('option', { name: 'foggybrain/state.json', exact: true }).click();
  await expect(dialog).toContainText('GH_TOKEN / GITHUB_TOKEN / gh auth token');
  await expect(dialog).toContainText('Contents read/write');
  await dialog.getByRole('button', { name: 'Save workspace' }).click();
  await expect(page.getByRole('combobox', { name: 'Workspace', exact: true })).toContainText(
    'Research (Cloud)',
  );
  await expect(page).toHaveURL(/workspace=default/);
  expect(patches.at(-1)).toEqual({
    name: 'Research',
    type: 'cloud',
    target: { repo: 'example/private', branch: 'main', path: 'foggybrain/state.json' },
    credential: 'github',
  });
});

test('discovery spinners follow each pending request and respect reduced motion', async ({
  page,
}) => {
  const releases = new Map<string, () => void>();
  for (const kind of ['repositories', 'branches', 'files']) {
    await page.route(`**/api/workspaces/${kind}?*`, async (route) => {
      await new Promise<void>((resolve) => releases.set(kind, resolve));
      await route.fallback();
    });
  }
  await page.goto('/');
  await navigation(page);
  await page.getByRole('button', { name: 'Connect to cloud' }).click();
  const dialog = page.getByRole('dialog');
  for (const [kind, label, choice] of [
    ['repositories', 'Repository', 'example/private'],
    ['branches', 'Branch', 'main'],
    ['files', 'State file path', 'foggybrain/state.json'],
  ]) {
    const field = dialog.getByLabel(label, { exact: true });
    const spinner = field.locator('..').locator('.field-spinner');
    await expect(field).toBeDisabled();
    await expect(field).toHaveAttribute('aria-busy', 'true');
    await expect(field).toHaveAttribute('placeholder', `Loading ${kind}...`);
    await expect(field).toHaveCSS('cursor', 'progress');
    await expect(spinner).toBeVisible();
    await expect(spinner).toHaveCSS('animation-name', 'spin');
    await expect(dialog.locator('.field-spinner')).toHaveCount(1);
    const fieldBox = await field.boundingBox();
    const spinnerBox = await spinner.boundingBox();
    expect(fieldBox).not.toBeNull();
    expect(spinnerBox).not.toBeNull();
    expect(spinnerBox!.x).toBeGreaterThan(fieldBox!.x);
    expect(spinnerBox!.x + spinnerBox!.width).toBeLessThan(fieldBox!.x + fieldBox!.width);
    expect(spinnerBox!.y).toBeGreaterThanOrEqual(fieldBox!.y);
    expect(spinnerBox!.y + spinnerBox!.height).toBeLessThanOrEqual(fieldBox!.y + fieldBox!.height);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(spinner).toHaveCSS('animation-name', 'none');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect.poll(() => releases.has(kind)).toBe(true);
    releases.get(kind)!();
    await expect(field).toBeEnabled();
    await expect(field).toHaveAttribute('aria-busy', 'false');
    await expect(spinner).toHaveCount(0);
    await field.fill(choice);
    await dialog.getByRole('option', { name: choice, exact: true }).click();
  }
});

test('repository picker handles loading, missing credentials, retry, empty results and credential races', async ({
  page,
}) => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let attempt = 0;
  await page.route('**/api/workspaces/repositories?*', async (route) => {
    const credential = new URL(route.request().url()).searchParams.get('credential');
    if (credential === 'github')
      return route.fulfill({ json: { login: 'other-user', repositories: [] } });
    attempt++;
    if (attempt === 1)
      return route.fulfill({
        status: 503,
        json: { error: 'Dedicated sync credential is unavailable. Set FOGGY_SYNC_TOKEN.' },
      });
    await wait;
    return route.fulfill({
      json: {
        login: 'stale-user',
        repositories: [{ id: 1, fullName: 'stale-user/state', defaultBranch: 'main' }],
      },
    });
  });
  await page.goto('/');
  await navigation(page);
  await page.getByRole('button', { name: 'Connect to cloud' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('alert')).toContainText('FOGGY_SYNC_TOKEN');
  await expect(dialog.locator('.field-spinner')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Save workspace' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Retry repositories' }).click();
  await expect(dialog.getByRole('status')).toContainText('Loading repositories');
  await expect(dialog.locator('.field-spinner')).toBeVisible();
  await dialog.getByLabel('Server credential').selectOption('github');
  await expect(dialog).toContainText('Authenticated as other-user');
  await expect(dialog.locator('.field-spinner')).toHaveCount(0);
  await expect(dialog.getByRole('status')).toContainText('No owned private repositories');
  const response = page.waitForResponse((response) =>
    response.url().endsWith('repositories?credential=dedicated'),
  );
  release();
  await (await response).finished();
  await expect(dialog).not.toContainText('stale-user');
  await expect(dialog.getByRole('button', { name: 'Save workspace' })).toBeDisabled();
  await dialog.getByLabel('Repository', { exact: true }).click();
  await expect(dialog.getByRole('listbox').getByRole('option')).toHaveCount(0);
});

for (const flow of ['add', 'connect'] as const) {
  test(`${flow} repository combobox filters, preserves same selections, and invalidates edits`, async ({
    page,
  }) => {
    const writes: CreateWorkspaceInput[] = [];
    page.on('request', (request) => {
      if (['POST', 'PATCH'].includes(request.method()) && !request.url().includes('/sync/'))
        writes.push(request.postDataJSON());
    });
    await page.goto('/');
    await navigation(page);
    await page
      .getByRole('button', {
        name: flow === 'add' ? 'Add workspace' : 'Connect to cloud',
        exact: true,
      })
      .click();
    const dialog = page.getByRole('dialog');
    if (flow === 'add') {
      await dialog.getByLabel('Name', { exact: true }).fill('Cloud');
      await dialog.getByLabel('Storage type').selectOption('cloud');
    }
    const input = dialog.getByRole('combobox', { name: 'Repository', exact: true });
    const save = dialog.getByRole('button', { name: 'Save workspace' });
    await expect(dialog.getByLabel('Branch', { exact: true })).toBeDisabled();
    await expect(dialog.getByLabel('State file path')).toBeDisabled();
    await input.click();
    await expect(input).toHaveAttribute('aria-expanded', 'true');
    await expect(dialog.getByRole('listbox')).toHaveAttribute(
      'id',
      (await input.getAttribute('aria-controls')) as string,
    );
    await input.press('ArrowDown');
    await expect(input).toHaveAttribute('aria-activedescendant', 'workspace-repository-1');
    await input.press('ArrowDown');
    await expect(input).toHaveAttribute('aria-activedescendant', 'workspace-repository-2');
    await input.press('ArrowUp');
    await input.press('Enter');
    await expect(input).toHaveValue('example/private');
    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute('aria-expanded', 'false');
    await expect(dialog.getByLabel('Branch', { exact: true })).toHaveValue('');
    await expect(save).toBeDisabled();
    expect(writes).toEqual([]);
    await input.fill('OTHER');
    await expect(save).toBeDisabled();
    await expect(input).not.toHaveAttribute('aria-activedescendant');
    await expect(dialog.getByRole('listbox').getByRole('option')).toHaveText(['example/other']);
    await input.press('Escape');
    await expect(dialog).toBeVisible();
    await expect(input).toHaveAttribute('aria-expanded', 'false');
    await input.press('ArrowUp');
    await input.press('Enter');
    await expect(input).toHaveValue('example/other');
    await expect(dialog.getByLabel('Branch', { exact: true })).toHaveValue('');
    await dialog.getByLabel('Branch', { exact: true }).fill('custom');
    await input.fill('');
    await expect(save).toBeDisabled();
    await expect(dialog.getByRole('listbox').getByRole('option')).toHaveCount(2);
    await input.fill('example/private');
    await expect(save).toBeDisabled();
    await input.press('Enter');
    expect(writes).toEqual([]);
    await dialog.getByRole('option', { name: 'example/private', exact: true }).click();
    await expect(dialog.getByLabel('Branch', { exact: true })).toHaveValue('');
    await input.press('ArrowDown');
    await input.press('Tab');
    await expect(input).toHaveAttribute('aria-expanded', 'false');
    await expect(input).not.toHaveAttribute('aria-activedescendant');
    const branch = dialog.getByLabel('Branch', { exact: true });
    await branch.fill('UST');
    await expect(dialog.getByRole('listbox').getByRole('option')).toHaveText(['custom']);
    await branch.press('ArrowDown');
    await branch.press('Escape');
    await expect(dialog).toBeVisible();
    await branch.press('ArrowUp');
    await branch.press('Enter');
    await expect(branch).toHaveValue('custom');
    const path = dialog.getByLabel('State file path');
    await path.fill('other');
    await dialog.getByRole('option', { name: 'other.json', exact: true }).click();
    await expect(save).toBeEnabled();
    await branch.fill('trunk');
    await expect(path).toBeDisabled();
    await expect(path).toHaveValue('');
    await branch.press('ArrowDown');
    await branch.press('Enter');
    await path.fill('../unsafe.json');
    await expect(save).toBeDisabled();
    await expect(dialog.getByRole('listbox').getByRole('option')).toHaveCount(0);
    await path.fill('new/state.json');
    await expect(dialog.getByRole('listbox').getByRole('option')).toHaveText([
      'Use new path: new/state.json',
    ]);
    await path.press('ArrowDown');
    await path.press('Enter');
    for (const picker of [branch, input]) {
      await picker.click();
      await picker.press('ArrowDown');
      await picker.press('Enter');
      await expect(input).toHaveValue('example/private');
      await expect(branch).toHaveValue('trunk');
      await expect(path).toHaveValue('new/state.json');
      await expect(path).toBeEnabled();
      await expect(save).toBeEnabled();
    }
    await save.click();
    await expect(page.getByRole('dialog', { name: 'Workspace sync', exact: true })).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Review sync preview' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Apply sync' })).toBeDisabled();
    expect(writes).toHaveLength(1);
    expect(writes[0].target).toEqual({
      repo: 'example/private',
      branch: 'trunk',
      path: 'new/state.json',
    });
  });
}

test('branch and file discovery load automatically, retry errors, and discard stale repository results', async ({
  page,
}) => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let attempts = 0;
  await page.route('**/api/workspaces/branches?*', async (route) => {
    const query = new URL(route.request().url()).searchParams;
    expect(query.get('credential')).toBe('dedicated');
    if (query.get('repo') === 'example/private') {
      await waiting;
      return route.fulfill({ json: { branches: ['stale'] } });
    }
    attempts++;
    return route.fulfill(
      attempts === 1
        ? { status: 502, json: { error: 'Branch discovery unavailable' } }
        : { json: { branches: ['main'] } },
    );
  });
  let files = 0;
  await page.route('**/api/workspaces/files?*', (route) => {
    const query = new URL(route.request().url()).searchParams;
    expect(query.get('repo')).toBe('example/other');
    expect(query.get('branch')).toBe('main');
    files++;
    return route.fulfill(
      files === 1
        ? { status: 502, json: { error: 'File tree is incomplete' } }
        : { json: { paths: [] } },
    );
  });
  await page.goto('/');
  await navigation(page);
  await page.getByRole('button', { name: 'Connect to cloud' }).click();
  const dialog = page.getByRole('dialog');
  const repo = dialog.getByLabel('Repository', { exact: true });
  const branch = dialog.getByLabel('Branch', { exact: true });
  const path = dialog.getByLabel('State file path');
  await repo.fill('private');
  await dialog.getByRole('option', { name: 'example/private', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText('Loading branches...');
  await expect(branch).toBeDisabled();
  await repo.fill('other');
  await dialog.getByRole('option', { name: 'example/other', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Branch discovery unavailable');
  await expect(dialog.locator('.field-spinner')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Retry branches' }).click();
  await expect(branch).toBeEnabled();
  const response = page.waitForResponse(
    (res) => res.url().includes('repo=example%2Fprivate') && res.url().includes('/branches?'),
  );
  release();
  await (await response).finished();
  await branch.click();
  await expect(dialog.getByRole('listbox').getByRole('option')).toHaveText(['main']);
  await branch.press('ArrowDown');
  await branch.press('Enter');
  await expect(dialog.getByRole('alert')).toContainText('File tree is incomplete');
  await expect(dialog.locator('.field-spinner')).toHaveCount(0);
  await expect(path).toBeDisabled();
  await dialog.getByRole('button', { name: 'Retry files' }).click();
  await expect(path).toBeEnabled();
  await path.fill('new.json');
  await dialog.getByRole('option', { name: 'Use new path: new.json', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Save workspace' })).toBeEnabled();
  await dialog.getByLabel('Server credential').selectOption('github');
  await expect(repo).toHaveValue('');
  await expect(branch).toHaveValue('');
  await expect(branch).toBeDisabled();
  await expect(path).toHaveValue('');
  await expect(path).toBeDisabled();
});

test('discovery errors and unknown workspace links never load a fallback graph', async ({
  page,
}) => {
  const stateReads: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/state')) stateReads.push(request.url());
  });
  await page.goto('/?workspace=missing#/map');
  await expect(page.getByRole('alert')).toContainText('This workspace is not available');
  expect(stateReads).toEqual([]);
  await page.route('**/api/workspaces', (route) =>
    route.fulfill({ status: 503, json: { error: 'Discovery unavailable' } }),
  );
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Discovery unavailable');
  expect(stateReads).toEqual([]);
});

test('switching during a task write keeps requests scoped and ignores old navigation', async ({
  page,
}) => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  const writes: string[] = [];
  await page.route('**/api/workspaces/default/tasks', async (route) => {
    writes.push(new URL(route.request().url()).pathname);
    started = true;
    await wait;
    await route.fulfill({ json: { id: 'old-task', kind: 'container', parentId: null } });
  });
  await page.goto('/');
  await navigation(page);
  await page.getByRole('button', { name: 'Add workspace', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Other');
  await page.getByRole('button', { name: 'Save workspace' }).click();
  await expect(page).toHaveURL(/workspace=space-1/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await navigation(page);
  await page.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption('default');
  await expect(page).toHaveURL(/workspace=default/);
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Summary').fill('Old workspace task');
  await page.getByRole('dialog').getByRole('button', { name: 'Create task', exact: true }).click();
  await expect.poll(() => started).toBe(true);
  // History changes can switch workspaces even while a mutation dialog is open.
  await page.goBack();
  await expect(page).toHaveURL(/workspace=space-1/);
  const response = page.waitForResponse('**/api/workspaces/default/tasks');
  release();
  await (await response).finished();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'A little room to think.' })).toBeVisible();
  await navigation(page);
  await expect(page.getByRole('combobox', { name: 'Workspace', exact: true })).toHaveValue(
    'space-1',
  );
  expect(writes).toEqual(['/api/workspaces/default/tasks']);
  await expect(page).not.toHaveURL(/old-task/);
});

test('workspace switching isolates graph results and resets search state', async ({ page }) => {
  await page.route('**/api/workspaces', (route) =>
    route.fulfill({
      json: {
        workspaces: ['default', 'other'].map((id) => ({
          id,
          name: id,
          type: 'local',
          target: null,
          credential: null,
        })),
        defaultWorkspaceId: 'default',
        limit: 3,
      },
    }),
  );
  await page.route('**/api/workspaces/*/state', (route) => {
    const id = new URL(route.request().url()).pathname.split('/')[3];
    const task: TaskView = {
      id: `${id}-task`,
      title: `${id} task`,
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
    };
    return route.fulfill({
      json: { tasks: [task], dependencies: [], references: [], layouts: [] },
    });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'default task', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Search tasks' }).fill('default');
  await navigation(page);
  await page.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption('other');
  await expect(page.getByRole('heading', { name: 'other task', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'default task', exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Search tasks' })).toHaveValue('');
  await navigation(page);
  await page.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption('default');
  await expect(page.getByRole('heading', { name: 'default task', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'other task', exact: true })).toHaveCount(0);
});

test('focus refresh discovers external metadata changes without resetting graph state', async ({
  page,
}) => {
  const metadata: WorkspaceList = {
    workspaces: [
      { id: 'default', name: 'Personal', type: 'local', target: null, credential: null },
    ],
    defaultWorkspaceId: 'default',
    limit: 3,
  };
  let failure = false;
  await page.route('**/api/workspaces', (route) =>
    route.fulfill(
      failure ? { status: 503, json: { error: 'Discovery offline' } } : { json: metadata },
    ),
  );
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Search tasks' }).fill('keep this search');
  metadata.workspaces.push(
    ...['second', 'third'].map((id): Workspace => ({
      id,
      name: id,
      type: 'local',
      target: null,
      credential: null,
    })),
  );
  metadata.workspaces[0].name = 'Renamed elsewhere';
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await navigation(page);
  await expect(page.getByRole('combobox', { name: 'Workspace', exact: true })).toContainText(
    'Renamed elsewhere (Local)',
  );
  await expect(
    page.getByRole('combobox', { name: 'Workspace', exact: true }).getByRole('option'),
  ).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Add workspace', exact: true })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: 'Search tasks' })).toHaveValue('keep this search');
  failure = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('alert')).toContainText('Discovery offline');
  await expect(page.getByRole('combobox', { name: 'Workspace', exact: true })).toHaveValue(
    'default',
  );
  await expect(page.getByRole('textbox', { name: 'Search tasks' })).toHaveValue('keep this search');
  failure = false;
  await page.getByRole('button', { name: 'About local storage' }).click();
  await expect(page.getByRole('dialog')).toContainText('This is a local workspace');
  const target = { repo: 'example/private', branch: 'main', path: 'foggybrain/state.json' };
  Object.assign(metadata.workspaces[0], { type: 'cloud', target, credential: 'dedicated' });
  await page.route('**/api/workspaces/default/sync/status', (route) =>
    route.fulfill({
      json: { configured: true, target, lastSync: null, dirty: true, syncing: false },
    }),
  );
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(
    page
      .getByRole('dialog', { name: 'Workspace sync', exact: true })
      .getByRole('button', { name: 'Preview sync' }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.getByRole('combobox', { name: 'Workspace', exact: true })).toContainText(
    'Renamed elsewhere (Cloud)',
  );
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Search tasks' })).toHaveValue('keep this search');
});

test('explicit switch and creation reset task routes but history and direct links preserve them', async ({
  page,
}) => {
  await page.goto('/?workspace=default#/tasks/deep-task');
  await expect(page).toHaveURL(/workspace=default#\/tasks\/deep-task$/);
  await navigation(page);
  await page.getByRole('button', { name: 'Add workspace', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Other');
  await page.getByRole('button', { name: 'Save workspace' }).click();
  await expect(page).toHaveURL(/workspace=space-1#\/$/);
  await expect(page.getByRole('heading', { name: 'A little room to think.' })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/workspace=default#\/tasks\/deep-task$/);
  await navigation(page);
  await page.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption('space-1');
  await expect(page).toHaveURL(/workspace=space-1#\/$/);
  await expect(page.getByRole('heading', { name: 'A little room to think.' })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/workspace=default#\/tasks\/deep-task$/);
  await navigation(page);
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Renamed');
  await page.getByRole('button', { name: 'Save workspace' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).toHaveURL(/workspace=default#\/tasks\/deep-task$/);
});

test('settings direct route shows metadata and renames without preview; blur and padding preserve the editor', async ({
  page,
}) => {
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET') writes.push(new URL(request.url()).pathname);
  });
  await page.goto('/?other=kept&workspace=default#/settings');
  const settings = page.getByRole('region', { name: 'Workspace settings' });
  await expect(settings).toBeVisible();
  await expect(settings.locator('dd')).toHaveText([
    'Personal',
    'Local',
    'Not connected',
    'Not configured',
    'Not configured',
    'Not configured',
  ]);
  await expect(settings.getByRole('button', { name: 'Connect to cloud' })).toBeVisible();
  await expect(settings.getByRole('button', { name: 'Add workspace', exact: true })).toBeEnabled();
  await settings.getByRole('button', { name: 'Rename workspace' }).click();
  const dialog = page.getByRole('dialog', { name: 'Rename workspace' });
  const name = dialog.getByLabel('Name', { exact: true });
  await name.fill('Research');
  await name.press('Tab');
  await expect(dialog).toBeVisible();
  await expect(name).toHaveValue('Research');
  await dialog.click({ position: { x: 5, y: 5 } });
  await expect(dialog).toBeVisible();
  await expect(name).toHaveValue('Research');
  expect(writes).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(settings.locator('dd').first()).toHaveText('Personal');
  await settings.getByRole('button', { name: 'Rename workspace' }).click();
  await name.fill('Research');
  await dialog.getByRole('button', { name: 'Save workspace' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(settings.locator('dd').first()).toHaveText('Research');
  await page.reload();
  await expect(settings.locator('dd').first()).toHaveText('Research');
  await expect(page).toHaveURL(/other=kept&workspace=default#\/settings$/);
  expect(writes).toEqual(['/api/workspaces/default']);
});

for (const flow of ['create', 'connect'] as const) {
  test(`${flow} cloud previews once in the selected workspace and imports only after confirmation`, async ({
    page,
  }) => {
    const id = flow === 'create' ? 'space-1' : 'default';
    const syncWrites: { path: string; body: unknown }[] = [];
    const stateReads: string[] = [];
    let applied = false;
    const task: TaskView = {
      id: 'imported-task',
      title: 'Imported remote task',
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
    };
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() === 'POST' && path.includes('/sync/'))
        syncWrites.push({ path, body: request.postDataJSON() });
    });
    await page.route('**/api/workspaces/*/state', (route) => {
      const path = new URL(route.request().url()).pathname;
      stateReads.push(path);
      return route.fulfill({
        json: {
          tasks: applied && path === `/api/workspaces/${id}/state` ? [task] : [],
          dependencies: [],
          references: [],
          layouts: [],
        },
      });
    });
    await page.route('**/api/workspaces/*/sync/preview', (route) =>
      route.fulfill({
        json: {
          previewId: `import-${id}`,
          target: { repo: 'example/private', branch: 'main', path: 'foggybrain/state.json' },
          localChanges: [{ collection: 'tasks', id: task.id, title: task.title, kind: 'added' }],
          remoteChanges: [],
          conflicts: [],
          validationError: null,
          canApply: true,
          resolution: null,
        } satisfies SyncPreview,
      }),
    );
    await page.route('**/api/workspaces/*/sync/apply', (route) => {
      applied = true;
      return route.fulfill({
        json: {
          configured: true,
          target: { repo: 'example/private', branch: 'main', path: 'foggybrain/state.json' },
          lastSync: '2026-09-08T00:00:00Z',
          dirty: false,
          syncing: false,
        },
      });
    });
    await page.goto('/?workspace=default#/settings');
    const settings = page.getByRole('region', { name: 'Workspace settings' });
    await settings
      .getByRole('button', {
        name: flow === 'create' ? 'Add workspace' : 'Connect to cloud',
        exact: true,
      })
      .click();
    if (flow === 'create') {
      await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Imported workspace');
      await page.getByRole('dialog').getByLabel('Storage type').selectOption('cloud');
    }
    await selectCloudTarget(page);
    await page.getByRole('button', { name: 'Save workspace' }).click();
    const sync = page.getByRole('dialog', { name: 'Workspace sync', exact: true });
    await expect(sync.getByRole('region', { name: 'Changes to local state' })).toContainText(
      task.title,
    );
    await expect(sync.getByRole('region', { name: 'Changes to remote state' })).toContainText(
      'No changes',
    );
    await expect(sync.getByRole('button', { name: 'Apply sync' })).toBeDisabled();
    expect(applied).toBe(false);
    expect(syncWrites).toEqual([{ path: `/api/workspaces/${id}/sync/preview`, body: {} }]);
    await sync.click({ position: { x: 5, y: 5 } });
    await expect(sync).toBeVisible();
    await sync.getByRole('checkbox').check();
    expect(applied).toBe(false);
    stateReads.length = 0;
    await sync.getByRole('button', { name: 'Apply sync' }).click();
    await expect(sync.getByRole('status')).toContainText('Workspace sync applied successfully');
    expect(stateReads).toEqual([`/api/workspaces/${id}/state`]);
    await sync.getByRole('button', { name: 'Close dialog' }).click();
    await expect(settings.locator('dd')).toHaveText([
      flow === 'create' ? 'Imported workspace' : 'Personal',
      'Cloud',
      'example/private',
      'main',
      'foggybrain/state.json',
      'Dedicated sync token (FOGGY_SYNC_TOKEN)',
    ]);
    await expect(settings.getByRole('button', { name: 'Connect to cloud' })).toHaveCount(0);
    await settings.getByRole('button', { name: 'Rename workspace' }).click();
    await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Renamed cloud');
    await page.getByRole('button', { name: 'Save workspace' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.reload();
    await expect(settings.locator('dd').first()).toHaveText('Renamed cloud');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await navigation(page);
    await page.getByRole('button', { name: 'Workspace sync', exact: true }).click();
    await expect(sync.getByRole('button', { name: 'Preview sync' })).toBeEnabled();
    await sync.getByRole('button', { name: 'Refresh status' }).click();
    await expect(sync.getByRole('button', { name: 'Preview sync' })).toBeEnabled();
    await page.keyboard.press('Escape');
    await expect(sync).toHaveCount(0);
    await page.goto(`/?workspace=${id}#/`);
    await expect(page.getByRole('heading', { name: task.title, exact: true })).toBeVisible();
    expect(syncWrites).toEqual([
      { path: `/api/workspaces/${id}/sync/preview`, body: {} },
      {
        path: `/api/workspaces/${id}/sync/apply`,
        body: { previewId: `import-${id}`, confirm: true },
      },
    ]);
  });
}

test('failed automatic preview preserves the saved cloud connection without applying', async ({
  page,
}) => {
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET') writes.push(new URL(request.url()).pathname);
  });
  await page.route('**/api/workspaces/default/sync/preview', (route) =>
    route.fulfill({
      status: 502,
      json: { error: 'Remote state is unavailable' },
    }),
  );
  await page.goto('/?workspace=default#/settings');
  const settings = page.getByRole('region', { name: 'Workspace settings' });
  await settings.getByRole('button', { name: 'Connect to cloud' }).click();
  await selectCloudTarget(page);
  await page.getByRole('button', { name: 'Save workspace' }).click();
  const sync = page.getByRole('dialog', { name: 'Workspace sync', exact: true });
  await expect(sync.getByRole('alert')).toContainText('Remote state is unavailable');
  await expect(sync.getByRole('button', { name: 'Apply sync' })).toHaveCount(0);
  await sync.getByRole('button', { name: 'Close dialog' }).click();
  await page.reload();
  await expect(settings.locator('dd')).toHaveText([
    'Personal',
    'Cloud',
    'example/private',
    'main',
    'foggybrain/state.json',
    'Dedicated sync token (FOGGY_SYNC_TOKEN)',
  ]);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(writes).toEqual(['/api/workspaces/default', '/api/workspaces/default/sync/preview']);
});
