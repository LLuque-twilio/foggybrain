import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Dependency, PrMergeStatus, PrState, Snapshot, TaskView } from '../src/shared';

async function create(
  request: APIRequestContext,
  title: string,
  kind = 'manual',
  parentId?: string,
) {
  const response = await request.post('/api/tasks', { data: { title, kind, parentId } });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as TaskView;
}

function node(page: Page, id: string) {
  return page.locator(`.react-flow__node[data-id="${id}"]`);
}

test.beforeEach(async ({ request }) => {
  const snapshot = (await (await request.get('/api/state')).json()) as Snapshot;
  for (const task of snapshot.tasks.filter((task) => task.parentId === null)) {
    expect((await request.delete(`/api/tasks/${task.id}?confirm=true`)).ok()).toBeTruthy();
  }
  for (const tag of snapshot.tags.filter((tag) => !tag.system)) {
    expect((await request.delete(`/api/tags/${tag.id}?confirm=true`)).ok()).toBeTruthy();
  }
  expect(
    (await request.put('/api/preferences', { data: { hideCompleted: true } })).ok(),
  ).toBeTruthy();
});

test('create/edit through UI, keyboard dialog, local assets, and responsive shell', async ({
  page,
}) => {
  const errors: string[] = [];
  const remote: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (!request.url().startsWith('http://127.0.0.1:4189/')) remote.push(request.url());
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'A little room to think.' })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
  await page.screenshot({ path: test.info().outputPath('overview.png'), fullPage: true });
  await page.getByRole('button', { name: 'Create your first task' }).click();
  const dialog = page.locator('.dialog');
  await dialog.getByLabel('Summary').fill('Ship to stage');
  await dialog.getByLabel('Description').fill('Release the API without holding it all in my head.');
  await dialog.getByRole('button', { name: 'Create task', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ship to stage', exact: true })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'A clear space for a messy idea.' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Add your first step' }).click();
  await dialog.getByLabel('Summary').fill('Implement the change');
  await dialog.getByRole('button', { name: 'Create task', exact: true }).click();
  await expect(
    page.locator('.node-title').filter({ hasText: 'Implement the change' }),
  ).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Task details' })).toBeVisible();
  await page.getByRole('button', { name: 'Edit task', exact: true }).click();
  await dialog.getByLabel('Summary').fill('Implement API v2');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.locator('.node-title')).toHaveText('Implement API v2');
  await page.getByRole('button', { name: 'Mark own work done' }).click();
  await expect(page.locator('.graph-title .status')).toHaveText('Completed');
  await page.getByRole('button', { name: 'Close task details' }).click();
  await page.getByRole('button', { name: 'Edit container' }).click();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
  await page.screenshot({ path: test.info().outputPath('graph.png'), fullPage: true });
  expect(errors).toEqual([]);
  expect(remote).toEqual([]);
});

test('breadcrumbs retain the map and back follows navigation across reload and browser history', async ({
  request,
  page,
}) => {
  const parent = await create(request, 'Release', 'container');
  const child = await create(request, 'Deploy', 'container', parent.id);
  await page.goto('/#/map');
  await page.getByRole('button', { name: 'Open Release graph' }).click();
  const breadcrumbs = page.getByRole('navigation', { name: 'Breadcrumb', exact: true });
  await expect(breadcrumbs.getByRole('button').filter({ hasNot: page.locator('svg') })).toHaveText([
    'Personal',
    'Map',
    'Release',
  ]);
  await expect(breadcrumbs.locator('[aria-current="page"]')).toHaveText('Release');
  await page.getByRole('button', { name: 'Open Deploy graph' }).click();
  await expect(breadcrumbs.locator('[aria-current="page"]')).toHaveText('Deploy');
  await expect(breadcrumbs.locator('svg.lucide-chevron-right')).toHaveCount(3);
  await page.reload();
  await page.getByRole('button', { name: 'Back to Release', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/tasks/${parent.id}$`));
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`#/tasks/${child.id}$`));
  await page.goBack();
  await page.getByRole('button', { name: 'Back to Workspace map', exact: true }).click();
  await expect(page).toHaveURL(/#\/map$/);
  await page.getByRole('button', { name: 'Open Release graph' }).click();
  await breadcrumbs.getByRole('button', { name: 'Release', exact: true }).click();
  await page.getByRole('button', { name: 'Back to Workspace map', exact: true }).click();
  await expect(page).toHaveURL(/#\/map$/);
  await page.getByRole('button', { name: 'Open Release graph' }).click();
  await breadcrumbs.getByRole('button', { name: 'Map', exact: true }).click();
  await expect(page).toHaveURL(/#\/map$/);
  await breadcrumbs.getByRole('button', { name: 'Personal', exact: true }).click();
  await page.locator('.card-main').filter({ hasText: 'Release' }).click();
  await page.getByRole('button', { name: 'Back to Overview', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A little room to think.' })).toBeVisible();
});

test('direct container links have an in-app back fallback', async ({ request, page }) => {
  const parent = await create(request, 'Release', 'container');
  const child = await create(request, 'Deploy', 'container', parent.id);
  await page.goto(`/#/tasks/${child.id}`);
  await page.getByRole('button', { name: 'Back to Release', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/tasks/${parent.id}$`));
});

test('early-ready chain propagates, floats remain independent, reopening preserves own work', async ({
  request,
  page,
}) => {
  const parent = await create(request, 'Implement thing', 'container');
  const a = await create(request, 'Step A', 'manual', parent.id);
  const b = await create(request, 'Step B', 'manual', parent.id);
  const c = await create(request, 'Step C', 'manual', parent.id);
  const d = await create(request, 'Floating D', 'manual', parent.id);
  await request.post('/api/dependencies', { data: { prerequisiteId: a.id, dependentId: b.id } });
  await request.post('/api/dependencies', { data: { prerequisiteId: b.id, dependentId: c.id } });
  await page.goto(`/#/tasks/${parent.id}`);
  await expect(node(page, d.id).locator('.status')).toHaveText('Available');
  await node(page, b.id).click();
  await page.getByRole('button', { name: 'Mark own work done' }).click();
  await expect(node(page, b.id).locator('.status')).toHaveText('Ready');
  await page.getByRole('button', { name: 'Close task details' }).click();
  await node(page, a.id).click();
  await page.getByRole('button', { name: 'Mark own work done' }).click();
  await expect(node(page, b.id).locator('.status')).toHaveText('Completed');
  await expect(node(page, c.id).locator('.status')).toHaveText('Available');
  await page.getByRole('button', { name: 'Reopen own work' }).click();
  await expect(node(page, b.id).locator('.status')).toHaveText('Ready');
  await expect(node(page, c.id).locator('.status')).toHaveText('Blocked');
  await expect(node(page, d.id).locator('.status')).toHaveText('Available');
  await page.getByRole('button', { name: 'Close task details' }).click();
  await page.screenshot({ path: test.info().outputPath('branching.png'), fullPage: true });
});

test('link existing container, navigate its graph, confirm deletion impact and unblock dependent work', async ({
  request,
  page,
}) => {
  const stage = await create(request, 'Ship to stage', 'container');
  await create(request, 'Merge and deploy', 'manual', stage.id);
  const prod = await create(request, 'Ship to prod', 'container');
  const smoke = await create(request, 'Smoke tests', 'manual', prod.id);
  await page.goto(`/#/tasks/${prod.id}`);
  await page.getByRole('button', { name: 'Link task', exact: true }).click();
  const dialog = page.locator('.dialog');
  await dialog.getByRole('button', { name: /Ship to stage/ }).click();
  await dialog.getByRole('button', { name: 'Link task', exact: true }).click();
  await expect(node(page, stage.id)).toBeVisible();
  await node(page, smoke.id).click();
  await page.getByRole('button', { name: 'Add prerequisite', exact: true }).click();
  await dialog.getByRole('combobox', { name: 'Existing prerequisite' }).fill('Ship to stage');
  await dialog.getByRole('option', { name: 'Ship to stage', exact: true }).click();
  await page.getByRole('button', { name: 'Connect prerequisite' }).click();
  await expect(node(page, smoke.id).locator('.status')).toHaveText('Blocked');
  await page.getByRole('button', { name: 'Close task details' }).click();
  await page.getByRole('button', { name: 'Open Ship to stage graph' }).click();
  await expect(page.locator('.graph-title h1')).toHaveText('Ship to stage');
  await page.getByRole('button', { name: 'Back to Ship to prod', exact: true }).click();
  await expect(page.locator('.graph-title h1')).toHaveText('Ship to prod');
  await page.getByRole('button', { name: 'Open Ship to stage graph' }).click();
  await page.getByRole('button', { name: 'Delete container', exact: true }).click();
  await expect(dialog).toContainText('Ship to prod');
  await expect(dialog).toContainText('Smoke tests');
  await dialog.getByRole('button', { name: 'Keep task' }).click();
  await expect(page.locator('.graph-title h1')).toHaveText('Ship to stage');
  await page.getByRole('button', { name: 'Delete container', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete permanently' }).click();
  await expect(page.getByRole('heading', { name: 'A little room to think.' })).toBeVisible();
  await page.goto(`/#/tasks/${prod.id}`);
  await expect(node(page, smoke.id).locator('.status')).toHaveText('Available');
  await expect(node(page, stage.id)).toHaveCount(0);
});

for (const direction of ['prerequisite', 'dependent'] as const) {
  test(`existing ${direction} leaf picker filters, selects by keyboard, and invalidates edited selections`, async ({
    request,
    page,
  }) => {
    const parent = await create(request, 'Release', 'container');
    const anchor = await create(request, 'Deploy', 'manual', parent.id);
    const existing = await create(request, 'Already connected', 'manual', parent.id);
    const candidate = await create(request, 'External review');
    const endpoints = (id: string) =>
      direction === 'prerequisite'
        ? { prerequisiteId: id, dependentId: anchor.id }
        : { prerequisiteId: anchor.id, dependentId: id };
    const response = await request.post('/api/dependencies', { data: endpoints(existing.id) });
    expect(response.ok()).toBeTruthy();
    const original = (await response.json()) as Dependency;
    await page.goto(`/#/tasks/${parent.id}`);
    await node(page, anchor.id).click();
    await page.getByRole('button', { name: `Add ${direction}`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: `Add ${direction}`, exact: true });
    const picker = dialog.getByRole('combobox', { name: `Existing ${direction}` });
    const connect = dialog.getByRole('button', { name: `Connect ${direction}` });
    await expect(dialog.getByRole('radio', { name: /Insert as new leaf/ })).toBeChecked();
    await expect(connect).toBeDisabled();
    await picker.click();
    await expect(dialog.getByRole('option', { name: anchor.title, exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('option', { name: existing.title, exact: true })).toHaveCount(0);
    await picker.fill('EXTERNAL');
    await expect(dialog.getByRole('option')).toHaveText([candidate.title]);
    await picker.press('Enter');
    await expect(connect).toBeDisabled();
    await picker.press('ArrowDown');
    await picker.press('Enter');
    await expect(picker).toHaveValue(candidate.title);
    await expect(picker).toHaveAttribute('aria-expanded', 'false');
    await expect(connect).toBeEnabled();
    await picker.fill('No such task');
    await expect(connect).toBeDisabled();
    await expect(dialog.getByRole('status')).toContainText('No matching tasks');
    await picker.fill('review');
    await dialog.getByRole('option', { name: candidate.title, exact: true }).click();
    const connected = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/workspaces/default/tasks/${anchor.id}/connections`) &&
        response.request().method() === 'POST',
    );
    await connect.click();
    const result = await connected;
    expect(result.status()).toBe(201);
    expect(result.request().postDataJSON()).toEqual({ direction, taskId: candidate.id });
    await expect(dialog).not.toBeVisible();
    await expect(page).toHaveURL(new RegExp(`#/tasks/${parent.id}$`));
    const snapshot = (await (await request.get('/api/state')).json()) as Snapshot;
    expect(snapshot.dependencies).toHaveLength(2);
    expect(snapshot.dependencies).toEqual(
      expect.arrayContaining([original, expect.objectContaining(endpoints(candidate.id))]),
    );
    expect(snapshot.tasks.find((task) => task.id === candidate.id)?.parentId).toBeNull();
    expect(snapshot.references).toEqual([]);
  });

  test(`inserting an existing ${direction} splits only the chosen branch`, async ({
    request,
    page,
  }) => {
    const parent = await create(request, 'Branched release', 'container');
    const anchor = await create(request, 'Deploy', 'manual', parent.id);
    const branchA = await create(request, 'Branch A', 'manual', parent.id);
    const branchB = await create(request, 'Branch B', 'manual', parent.id);
    const opposite = await create(request, 'Other side', 'manual', parent.id);
    const inserted = await create(request, 'Insert review');
    const endpoints = (id: string) =>
      direction === 'prerequisite'
        ? { prerequisiteId: id, dependentId: anchor.id }
        : { prerequisiteId: anchor.id, dependentId: id };
    const originals: Dependency[] = [];
    for (const data of [
      endpoints(branchA.id),
      endpoints(branchB.id),
      direction === 'prerequisite'
        ? { prerequisiteId: anchor.id, dependentId: opposite.id }
        : { prerequisiteId: opposite.id, dependentId: anchor.id },
    ]) {
      const response = await request.post('/api/dependencies', { data });
      expect(response.ok()).toBeTruthy();
      originals.push((await response.json()) as Dependency);
    }
    await page.goto(`/#/tasks/${parent.id}`);
    await node(page, anchor.id).click();
    await page.getByRole('button', { name: `Add ${direction}`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: `Add ${direction}`, exact: true });
    await dialog.getByRole('radio', { name: /Insert in existing chain/ }).check();
    const edgePicker = dialog.getByRole('combobox', { name: 'Connection to split' });
    const picker = dialog.getByRole('combobox', { name: `Existing ${direction}` });
    const connect = dialog.getByRole('button', { name: `Connect ${direction}` });
    await expect(picker).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Create new task or PR' })).toBeDisabled();
    await edgePicker.fill('Branch A');
    await dialog.getByRole('option', { name: /Branch A/ }).click();
    await picker.fill(inserted.title);
    await dialog.getByRole('option', { name: inserted.title, exact: true }).click();
    await expect(connect).toBeEnabled();
    await edgePicker.fill('Branch B');
    await expect(picker).toBeDisabled();
    await expect(connect).toBeDisabled();
    await expect(dialog.getByRole('option')).toHaveCount(1);
    await edgePicker.press('ArrowDown');
    await edgePicker.press('Enter');
    await expect(picker).toHaveValue('');
    await expect(connect).toBeDisabled();
    await picker.fill(inserted.title);
    await picker.press('ArrowDown');
    await picker.press('Enter');
    const chain =
      direction === 'prerequisite'
        ? [branchB.id, inserted.id, anchor.id]
        : [anchor.id, inserted.id, branchB.id];
    const titles =
      direction === 'prerequisite'
        ? [branchB.title, inserted.title, anchor.title]
        : [anchor.title, inserted.title, branchB.title];
    await expect(dialog.getByRole('status')).toHaveText(titles.join(' \u2192 '));
    await connect.click();
    await expect(dialog).not.toBeVisible();
    const snapshot = (await (await request.get('/api/state')).json()) as Snapshot;
    expect(snapshot.dependencies).toHaveLength(4);
    expect(snapshot.dependencies).toEqual(
      expect.arrayContaining([
        originals[0],
        originals[2],
        expect.objectContaining({ prerequisiteId: chain[0], dependentId: chain[1] }),
        expect.objectContaining({ prerequisiteId: chain[1], dependentId: chain[2] }),
      ]),
    );
    expect(snapshot.dependencies.some((edge) => edge.id === originals[1].id)).toBe(false);
    expect(snapshot.tasks.find((task) => task.id === inserted.id)?.parentId).toBeNull();
    await expect(page).toHaveURL(new RegExp(`#/tasks/${parent.id}$`));
  });
}

for (const { kind, label, direction } of [
  { kind: 'manual', label: 'Manual step', direction: 'prerequisite' },
  { kind: 'pr', label: 'PR merge', direction: 'dependent' },
  { kind: 'container', label: 'Container', direction: 'prerequisite' },
] as const) {
  test(`inline ${kind} creation atomically connects a ${direction} without leaving the selected graph`, async ({
    request,
    page,
  }) => {
    const parent = await create(request, 'Release', 'container');
    const anchor = await create(request, 'Deploy', 'manual', parent.id);
    await page.goto(`/#/tasks/${parent.id}`);
    await node(page, anchor.id).click();
    const writes: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST') writes.push(new URL(request.url()).pathname);
    });
    await page.getByRole('button', { name: `Add ${direction}`, exact: true }).click();
    const parentDialog = page.getByRole('dialog', { name: `Add ${direction}`, exact: true });
    await expect(
      parentDialog.getByRole('radio', { name: /Insert in existing chain/ }),
    ).toBeDisabled();
    await parentDialog.getByRole('button', { name: 'Create new task or PR' }).click();
    const dialog = page.getByRole('dialog', { name: `Create ${direction}`, exact: true });
    await expect(parentDialog).not.toBeVisible();
    await expect(page.locator('.dialog')).toHaveCount(1);
    await expect(dialog.getByRole('button', { name: 'Manual step', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await dialog.getByRole('button', { name: label, exact: true }).click();
    await dialog.getByLabel('Summary').fill(`New ${kind} gate`);
    await expect(dialog.getByLabel('Lives in')).toHaveValue(parent.id);
    const prUrl = 'https://github.com/example/release/pull/123';
    if (kind === 'pr') await dialog.getByLabel('GitHub PR URL').fill(prUrl);
    const path = `/api/workspaces/default/tasks/${anchor.id}/connections`;
    const connected = page.waitForResponse(
      (response) => response.url().endsWith(path) && response.request().method() === 'POST',
    );
    await dialog.getByRole('button', { name: 'Create and connect', exact: true }).click();
    const response = await connected;
    expect(response.status()).toBe(201);
    expect(response.request().postDataJSON()).toEqual({
      direction,
      task: {
        title: `New ${kind} gate`,
        description: '',
        kind,
        parentId: parent.id,
        tagIds: [],
        ...(kind === 'pr' ? { prUrl } : {}),
      },
    });
    const created = (await response.json()) as TaskView;
    await expect(page.locator('.dialog')).not.toBeVisible();
    await expect(page).toHaveURL(new RegExp(`#/tasks/${parent.id}$`));
    await expect(page.locator('.graph-title h1')).toHaveText(parent.title);
    await expect(
      page
        .getByRole('complementary', { name: 'Task details' })
        .getByRole('heading', { name: anchor.title, exact: true }),
    ).toBeVisible();
    expect(writes).toEqual([path]);
    const snapshot = (await (await request.get('/api/state')).json()) as Snapshot;
    expect(snapshot.tasks).toHaveLength(3);
    expect(snapshot.tasks.find((task) => task.id === created.id)).toMatchObject({
      title: `New ${kind} gate`,
      kind,
      parentId: parent.id,
      ownSatisfied: false,
      prUrl: kind === 'pr' ? prUrl : null,
    });
    expect(snapshot.dependencies).toEqual([
      expect.objectContaining(
        direction === 'prerequisite'
          ? { prerequisiteId: created.id, dependentId: anchor.id }
          : { prerequisiteId: anchor.id, dependentId: created.id },
      ),
    ]);
    expect(snapshot.references).toEqual([]);
  });
}

test('canceling inline creation restores chain placement and existing selection without writes', async ({
  request,
  page,
}) => {
  const parent = await create(request, 'Release', 'container');
  const anchor = await create(request, 'Deploy', 'manual', parent.id);
  const prerequisite = await create(request, 'Build', 'manual', parent.id);
  const candidate = await create(request, 'Review');
  expect(
    (
      await request.post('/api/dependencies', {
        data: { prerequisiteId: prerequisite.id, dependentId: anchor.id },
      })
    ).ok(),
  ).toBeTruthy();
  const before = (await (await request.get('/api/state')).json()) as Snapshot;
  await page.goto(`/#/tasks/${parent.id}`);
  await node(page, anchor.id).click();
  const writes: string[] = [];
  page.on('request', (request) => {
    if (['POST', 'PATCH', 'DELETE'].includes(request.method())) writes.push(request.url());
  });
  await page.getByRole('button', { name: 'Add prerequisite', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add prerequisite', exact: true });
  await dialog.getByRole('radio', { name: /Insert in existing chain/ }).check();
  await dialog.getByRole('combobox', { name: 'Connection to split' }).fill(prerequisite.title);
  await dialog.getByRole('option', { name: /Build/ }).click();
  await dialog.getByRole('combobox', { name: 'Existing prerequisite' }).fill(candidate.title);
  await dialog.getByRole('option', { name: candidate.title, exact: true }).click();
  await dialog.getByRole('button', { name: 'Create new task or PR' }).click();
  const createDialog = page.getByRole('dialog', { name: 'Create prerequisite', exact: true });
  await createDialog.getByLabel('Summary').fill('Discard this draft');
  await createDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('radio', { name: /Insert in existing chain/ })).toBeChecked();
  await expect(dialog.getByRole('combobox', { name: 'Connection to split' })).toHaveValue(
    `${prerequisite.title} \u2192 ${anchor.title}`,
  );
  await expect(dialog.getByRole('combobox', { name: 'Existing prerequisite' })).toHaveValue(
    candidate.title,
  );
  await expect(dialog.getByRole('button', { name: 'Connect prerequisite' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.dialog')).not.toBeVisible();
  expect(writes).toEqual([]);
  const after = (await (await request.get('/api/state')).json()) as Snapshot;
  expect(after.tasks).toEqual(before.tasks);
  expect(after.dependencies).toEqual(before.dependencies);
  expect(after.references).toEqual(before.references);
});

test('list filters combine tag OR selections with type and status criteria', async ({
  request,
  page,
}) => {
  const alphaResponse = await request.post('/api/tags', {
    data: { name: 'Alpha', color: '#7c5cff' },
  });
  const betaResponse = await request.post('/api/tags', {
    data: { name: 'Beta', color: '#4f8a67' },
  });
  expect(alphaResponse.ok()).toBeTruthy();
  expect(betaResponse.ok()).toBeTruthy();
  const alpha = (await alphaResponse.json()) as { id: string };
  const beta = (await betaResponse.json()) as { id: string };
  const containerResponse = await request.post('/api/tasks', {
    data: { title: 'Tagged container', kind: 'container', tagIds: [alpha.id] },
  });
  const alphaTaskResponse = await request.post('/api/tasks', {
    data: { title: 'Alpha task', kind: 'manual', tagIds: [alpha.id] },
  });
  const betaTaskResponse = await request.post('/api/tasks', {
    data: { title: 'Beta task', kind: 'manual', tagIds: [beta.id] },
  });
  const betaPrResponse = await request.post('/api/tasks', {
    data: {
      title: 'Beta PR',
      kind: 'pr',
      prUrl: 'https://github.com/example/release/pull/10',
      tagIds: [beta.id],
    },
  });
  const container = (await containerResponse.json()) as TaskView;
  const alphaTask = (await alphaTaskResponse.json()) as TaskView;
  const betaTask = (await betaTaskResponse.json()) as TaskView;
  const betaPr = (await betaPrResponse.json()) as TaskView;
  expect(
    (await request.post(`/api/tasks/${betaTask.id}/done`, { data: { done: true } })).ok(),
  ).toBeTruthy();
  expect(
    (await request.put(`/api/tasks/${betaPr.id}/tags/favorites`, { data: {} })).ok(),
  ).toBeTruthy();

  await page.goto('/#/list');
  const rows = page.locator('.task-list-row');
  const hideCompleted = page.getByRole('checkbox', { name: 'Hide completed?' });
  await expect(hideCompleted).toBeChecked();
  await expect(rows).toHaveCount(3);
  await expect(rows.filter({ hasText: 'Beta task' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Tags filter' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Alpha', exact: true }).click();
  await expect(rows).toHaveCount(2);
  await page.getByRole('menuitemcheckbox', { name: 'Beta', exact: true }).click();
  await expect(rows).toHaveCount(3);
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Type filter' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Manual step', exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('Alpha task');
  await page.keyboard.press('Escape');

  await hideCompleted.uncheck();
  await page.getByRole('button', { name: 'Status filter' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Completed', exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('Beta task');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Reset filters' }).click();
  await expect(rows).toHaveCount(4);
  await page.reload();
  await expect(hideCompleted).not.toBeChecked();
  await expect(rows).toHaveCount(4);
  await hideCompleted.check();
  await expect(rows).toHaveCount(3);
  await page.getByRole('button', { name: 'Tags filter' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Favorites', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('Beta PR');
  await page.getByRole('button', { name: 'Reset filters' }).click();

  await page.getByText(alphaTask.title, { exact: true }).click();
  await expect(page).toHaveURL(/#\/list$/);
  const detail = page.getByRole('complementary', { name: 'Task details' });
  await expect(detail).toBeVisible();
  await detail.getByRole('button', { name: `Add ${alphaTask.title} to Favorites` }).click();
  await expect(
    detail.getByRole('button', { name: `Remove ${alphaTask.title} from Favorites` }),
  ).toBeVisible();
  await detail.getByRole('button', { name: 'Close task details' }).click();
  await rows
    .filter({ hasText: alphaTask.title })
    .getByRole('button', { name: `Remove ${alphaTask.title} from Favorites` })
    .click();
  await expect(
    rows
      .filter({ hasText: alphaTask.title })
      .getByRole('button', { name: `Add ${alphaTask.title} to Favorites` }),
  ).toBeVisible();

  await rows
    .filter({ hasText: container.title })
    .getByText(container.title, { exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`#\/tasks\/${container.id}$`));
});

test('list constrains long task copy and opens details without resizing columns', async ({
  request,
  page,
}) => {
  const title = `A long task title ${'that needs room to wrap '.repeat(12)}`;
  const description = `Useful context ${'that should remain on one constrained line '.repeat(20)}`;
  const response = await request.post('/api/tasks', {
    data: { title, description, kind: 'manual' },
  });
  expect(response.ok()).toBeTruthy();

  await page.goto('/#/list');
  const list = page.locator('.task-list');
  const row = page.locator('.task-list-row').filter({ hasText: title });
  const titleElement = row.locator('.list-task-title strong');
  const descriptionElement = row.locator('.list-task-title small');
  const widthBefore = (await list.boundingBox())!.width;

  await expect(row.locator('.list-task-title > b')).toHaveCount(0);
  expect(await titleElement.evaluate((element) => getComputedStyle(element).webkitLineClamp)).toBe(
    '2',
  );
  expect(
    await descriptionElement.evaluate((element) => element.scrollWidth > element.clientWidth),
  ).toBeTruthy();

  await row.click();
  await expect(page.getByRole('complementary', { name: 'Task details' })).toBeVisible();
  const widthAfter = (await list.boundingBox())!.width;
  expect(Math.abs(widthAfter - widthBefore)).toBeLessThan(1);

  await page.keyboard.press('Escape');
  await expect(page.getByRole('complementary', { name: 'Task details' })).toHaveCount(0);
});

test('tag picker creates, caps, renames, previews deletion, and replaces dialog tags', async ({
  request,
  page,
}) => {
  const task = await create(request, 'Organize release');
  await page.goto('/#/list');
  await page.locator('.task-list-row').filter({ hasText: task.title }).click();
  const detail = page.getByRole('complementary', { name: 'Task details' });
  await detail.getByText('Add tag', { exact: true }).click();

  for (const name of ['Focus', 'Plan', 'Later']) {
    await detail.getByLabel('Find or create a tag').fill(name);
    await detail.getByRole('button', { name: `Create tag '${name}'` }).click();
    await detail.getByRole('button', { name: 'Create and add' }).click();
    await expect(detail.getByRole('button', { name: `Remove tag ${name}` })).toBeVisible();
  }
  await expect(detail.locator('.tag-picker-trigger')).toHaveAttribute('aria-disabled', 'true');
  await expect(detail.locator('.tag-picker-trigger')).toHaveAttribute(
    'title',
    'A task can have up to 3 tags. Favorites does not count.',
  );

  await detail.getByRole('button', { name: 'Edit tag Focus' }).click();
  await detail.getByLabel('Rename Focus').fill('Deep focus');
  await detail.getByRole('button', { name: 'Save Focus' }).click();
  await expect(detail.getByText('Deep focus', { exact: true }).first()).toBeVisible();
  await detail.getByRole('button', { name: 'Delete tag Deep focus' }).click();
  const deleteDialog = page.getByRole('dialog', { name: 'Delete this tag?' });
  await expect(deleteDialog).toContainText('Deep focus');
  await expect(deleteDialog).toContainText('removed from 1 task');
  await deleteDialog.getByRole('button', { name: 'Delete tag' }).click();
  await expect(deleteDialog).not.toBeVisible();
  await expect(detail.getByText('Deep focus', { exact: true })).toHaveCount(0);

  await detail.getByRole('button', { name: 'Edit task', exact: true }).click();
  const editDialog = page.getByRole('dialog', { name: 'Edit task' });
  await editDialog.getByRole('button', { name: 'Remove tag Plan' }).click();
  const replaced = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/tasks/${task.id}/tags`) && response.request().method() === 'PUT',
  );
  await editDialog.getByRole('button', { name: 'Save changes' }).click();
  const replacement = (await replaced).request().postDataJSON() as { tagIds: string[] };
  expect(replacement.tagIds).toHaveLength(1);
  await expect(detail.getByRole('button', { name: 'Remove tag Plan' })).toHaveCount(0);
  await expect(detail.getByRole('button', { name: 'Remove tag Later' })).toBeVisible();
});

test('a cycle error stays inside the dependency popup and leaves the graph unchanged', async ({
  request,
  page,
}) => {
  const parent = await create(request, 'Release', 'container');
  const anchor = await create(request, 'Build', 'manual', parent.id);
  const downstream = await create(request, 'Deploy', 'manual', parent.id);
  expect(
    (
      await request.post('/api/dependencies', {
        data: { prerequisiteId: anchor.id, dependentId: downstream.id },
      })
    ).ok(),
  ).toBeTruthy();
  const before = (await (await request.get('/api/state')).json()) as Snapshot;
  await page.goto(`/#/tasks/${parent.id}`);
  await node(page, anchor.id).click();
  await page.getByRole('button', { name: 'Add prerequisite', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add prerequisite', exact: true });
  await dialog.getByRole('combobox', { name: 'Existing prerequisite' }).fill(downstream.title);
  await dialog.getByRole('option', { name: downstream.title, exact: true }).click();
  await dialog.getByRole('button', { name: 'Connect prerequisite' }).click();
  await expect(dialog.getByRole('alert')).toContainText('cycle');
  await expect(dialog.getByRole('combobox', { name: 'Existing prerequisite' })).toHaveValue(
    downstream.title,
  );
  await expect(dialog.getByRole('button', { name: 'Connect prerequisite' })).toBeEnabled();
  const after = (await (await request.get('/api/state')).json()) as Snapshot;
  expect(after.tasks).toEqual(before.tasks);
  expect(after.dependencies).toEqual(before.dependencies);
});

test('a connection removed during inline chain creation reports an error without an orphan task', async ({
  request,
  page,
}) => {
  const parent = await create(request, 'Release', 'container');
  const anchor = await create(request, 'Build', 'manual', parent.id);
  const downstream = await create(request, 'Deploy', 'manual', parent.id);
  const edgeResponse = await request.post('/api/dependencies', {
    data: { prerequisiteId: anchor.id, dependentId: downstream.id },
  });
  expect(edgeResponse.ok()).toBeTruthy();
  const edge = (await edgeResponse.json()) as Dependency;
  await page.goto(`/#/tasks/${parent.id}`);
  await node(page, anchor.id).click();
  await page.getByRole('button', { name: 'Add dependent', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add dependent', exact: true });
  await dialog.getByRole('radio', { name: /Insert in existing chain/ }).check();
  await dialog.getByRole('combobox', { name: 'Connection to split' }).fill(downstream.title);
  await dialog.getByRole('option', { name: /Deploy/ }).click();
  await dialog.getByRole('button', { name: 'Create new task or PR' }).click();
  const createDialog = page.getByRole('dialog', { name: 'Create dependent', exact: true });
  await createDialog.getByLabel('Summary').fill('Must not be orphaned');
  let afterRemoval: Snapshot | undefined;
  await page.route(`**/api/workspaces/default/tasks/${anchor.id}/connections`, async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      direction: 'dependent',
      dependencyId: edge.id,
    });
    expect((await request.delete(`/api/dependencies/${edge.id}`)).ok()).toBeTruthy();
    afterRemoval = (await (await request.get('/api/state')).json()) as Snapshot;
    await route.continue();
  });
  await createDialog.getByRole('button', { name: 'Create and connect' }).click();
  await expect(createDialog.getByRole('alert')).toContainText('Dependency not found');
  await expect(createDialog.getByLabel('Summary')).toHaveValue('Must not be orphaned');
  await expect(createDialog.getByRole('button', { name: 'Create and connect' })).toBeEnabled();
  const after = (await (await request.get('/api/state')).json()) as Snapshot;
  expect(afterRemoval).toBeDefined();
  expect(after.tasks).toEqual(afterRemoval!.tasks);
  expect(after.dependencies).toEqual([]);
  expect(after.references).toEqual([]);
});

for (const kind of ['manual', 'pr'] as const) {
  test(`authored PR dropdown creates a ${kind} step and preserves custom summaries`, async ({
    page,
    request,
  }) => {
    const parent = await create(request, 'Release', 'container');
    const prs = [
      {
        url: 'https://github.com/example/api/pull/42',
        title: 'Improve API',
        number: 42,
        repository: 'example/api',
        state: 'open',
        draft: false,
        updatedAt: '2026-09-08T00:00:00Z',
      },
      {
        url: 'https://github.com/example/web/pull/42',
        title: 'Improve web',
        number: 42,
        repository: 'example/web',
        state: 'open',
        draft: true,
        updatedAt: '2026-09-08T00:00:00Z',
      },
    ];
    await page.route('**/api/workspaces/default/github/prs', (route) =>
      route.fulfill({ json: prs }),
    );
    await page.route('**/api/workspaces/default/github/status', (route) =>
      route.fulfill({
        json: {
          configured: true,
          login: 'example',
          lastSync: '2026-09-08T00:00:00Z',
          error: null,
          syncing: false,
        },
      }),
    );
    await page.goto(`/#/tasks/${parent.id}`);
    await page.getByRole('button', { name: 'Add your first step' }).click();
    const dialog = page.locator('.dialog');
    await dialog
      .getByRole('button', { name: kind === 'pr' ? 'PR merge' : 'Manual step', exact: true })
      .click();
    const picker = dialog.getByLabel('Your open pull requests');
    await expect(picker.locator('option')).toHaveText([
      'Select a PR or enter a URL below',
      'example/api #42: Improve API',
      'example/web #42: Improve web (draft)',
    ]);
    await picker.selectOption(prs[0].url);
    await expect(dialog.getByLabel('Summary')).toHaveValue(
      kind === 'pr' ? 'Merge Improve API' : 'Improve API',
    );
    await expect(dialog.getByLabel('GitHub PR URL')).toHaveValue(prs[0].url);
    await dialog.getByLabel('Summary').fill('Merge release changes');
    await picker.selectOption(prs[1].url);
    await expect(dialog.getByLabel('Summary')).toHaveValue('Merge release changes');
    await expect(dialog.getByLabel('Lives in')).toHaveValue(parent.id);
    expect(
      await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBeTruthy();
    await dialog.getByRole('button', { name: 'Create task', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    const snapshot = (await (await request.get('/api/state')).json()) as Snapshot;
    expect(snapshot.tasks.find((task) => task.title === 'Merge release changes')).toMatchObject({
      kind,
      parentId: parent.id,
      prUrl: prs[1].url,
      ownSatisfied: false,
    });
    await page.getByRole('button', { name: 'Edit task', exact: true }).click();
    await expect(picker).toHaveValue(prs[1].url);
    await dialog.getByLabel('GitHub PR URL').fill('https://github.com/example/other/pull/7');
    await expect(picker).toHaveValue('');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('link', { name: 'View PR on GitHub' })).toHaveAttribute(
      'href',
      'https://github.com/example/other/pull/7',
    );
  });
}

test('manual PR gate can be created, changed, removed, and added without losing manual work', async ({
  page,
  request,
}) => {
  const parent = await create(request, 'Release', 'container');
  await page.goto(`/#/tasks/${parent.id}`);
  await page.getByRole('button', { name: 'Add your first step' }).click();
  const dialog = page.locator('.dialog');
  await dialog.getByLabel('Summary').fill('Implement release');
  await dialog.getByLabel('Description').fill('Keep the manual context');
  await expect(dialog.getByLabel('GitHub PR URL')).not.toHaveAttribute('required');
  await dialog.getByLabel('GitHub PR URL').fill('https://github.com/example/api/pull/42');
  await dialog.getByRole('button', { name: 'Create task', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const snapshot = (await (await request.get('/api/state')).json()) as Snapshot;
  const task = snapshot.tasks.find((task) => task.title === 'Implement release')!;
  expect(task).toMatchObject({
    kind: 'manual',
    manualDone: false,
    prUrl: 'https://github.com/example/api/pull/42',
  });
  const card = node(page, task.id);
  const detail = page.getByRole('complementary', { name: 'Task details' });
  await expect(card).toContainText('MANUAL STEP');
  await expect(card.locator('.node-manual-work')).toHaveText('Manual work not done');
  await expect(card.locator('.node-pr-gate')).toContainText('Not checked');
  await expect(detail).toContainText('Keep the manual context');
  await detail.getByRole('button', { name: 'Mark own work done' }).click();
  await expect(card.locator('.node-manual-work')).toHaveText('Manual work done');
  await expect(card.locator('.status')).toHaveText('Available');
  await expect(detail.getByRole('button', { name: 'Reopen own work' })).toBeVisible();
  await detail.getByRole('button', { name: 'Edit task', exact: true }).click();
  await dialog.getByLabel('GitHub PR URL').fill('https://github.com/example/api/pull/43');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(detail.getByRole('link', { name: 'View PR on GitHub' })).toHaveAttribute(
    'href',
    'https://github.com/example/api/pull/43',
  );
  await detail.getByRole('button', { name: 'Edit task', exact: true }).click();
  await dialog.getByLabel('GitHub PR URL').fill('');
  const removed = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/tasks/${task.id}`) && response.request().method() === 'PATCH',
  );
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  expect((await removed).request().postDataJSON()).toMatchObject({ prUrl: null });
  await expect(card.locator('.node-pr-gate')).toHaveCount(0);
  await expect(card.getByRole('link')).toHaveCount(0);
  await expect(detail.locator('.pr-detail')).toHaveCount(0);
  await expect(card.locator('.status')).toHaveText('Completed');
  await expect(card.locator('.node-manual-work')).toHaveText('Manual work done');
  await detail.getByRole('button', { name: 'Edit task', exact: true }).click();
  await dialog.getByLabel('GitHub PR URL').fill('https://github.com/example/api/pull/44');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(card.locator('.status')).toHaveText('Available');
  await expect(card.locator('.node-pr-gate .pr-status')).toHaveText('Not checked');
  await detail.getByRole('button', { name: 'Reopen own work' }).click();
  await expect(card.locator('.node-manual-work')).toHaveText('Manual work not done');
  await expect(detail.getByRole('link', { name: 'View PR on GitHub' })).toBeVisible();
});

test('PR dropdown reports empty and stale GitHub results without blocking URL entry', async ({
  page,
}) => {
  await page.route('**/api/workspaces/default/github/prs', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/workspaces/default/github/status', (route) =>
    route.fulfill({
      json: {
        configured: true,
        login: 'example',
        lastSync: null,
        error: null,
        syncing: false,
      },
    }),
  );
  await page.goto('/#/prs');
  await page.getByRole('button', { name: 'Link a PR by URL' }).click();
  const dialog = page.locator('.dialog');
  await expect(dialog).toContainText('No authored open pull requests found.');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.route('**/api/workspaces/default/github/status', (route) =>
    route.fulfill({
      json: {
        configured: true,
        login: 'example',
        lastSync: null,
        error: 'Rate limit exceeded',
        syncing: false,
      },
    }),
  );
  await page.reload();
  await page.getByRole('button', { name: 'Link a PR by URL' }).click();
  await expect(dialog).toContainText('Listed PRs may be stale');
  await expect(dialog.getByLabel('GitHub PR URL')).toBeEditable();
});

test('PR picker shows in-field refresh progress without blocking manual URL entry', async ({
  page,
}) => {
  await page.route('**/api/workspaces/default/github/status', (route) =>
    route.fulfill({
      json: { configured: true, login: 'example', lastSync: null, error: null, syncing: true },
    }),
  );
  await page.goto('/#/prs');
  await page.getByRole('button', { name: 'Link a PR by URL' }).click();
  const dialog = page.locator('.dialog');
  await expect(dialog.getByLabel('Your open pull requests')).toHaveAttribute('aria-busy', 'true');
  await expect(dialog.locator('.field-spinner')).toBeVisible();
  await expect(dialog.getByRole('status')).toContainText('Refreshing your open pull requests');
  await expect(dialog.getByLabel('GitHub PR URL')).toBeEditable();
  await page.route('**/api/workspaces/default/github/status', (route) =>
    route.fulfill({
      json: { configured: true, login: 'example', lastSync: null, error: null, syncing: false },
    }),
  );
  await expect(dialog.getByLabel('Your open pull requests')).toHaveAttribute('aria-busy', 'false');
  await expect(dialog.locator('.field-spinner')).toHaveCount(0);
});

test('invalid PR errors stay inside dialog, PR tab works without credentials', async ({ page }) => {
  await page.goto('/#/prs');
  await expect(page.getByText('Connect GitHub when you are ready.')).toBeVisible();
  await page.getByRole('button', { name: 'Link a PR by URL' }).click();
  const dialog = page.locator('.dialog');
  await expect(dialog.getByLabel('GitHub PR URL')).toBeVisible();
  await expect(dialog).toContainText('GitHub is not connected.');
  await dialog.getByLabel('Summary').fill('Merge my PR');
  await dialog.getByLabel('GitHub PR URL').fill('https://example.com/owner/repo/pull/1');
  await dialog.getByRole('button', { name: 'Create task', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('HTTPS GitHub');
  await dialog.getByLabel('GitHub PR URL').fill('https://github.com/example/repo/pull/123');
  await dialog.getByRole('button', { name: 'Create task', exact: true }).click();
  await expect(page.locator('.node-title')).toHaveText('Merge my PR');
  await expect(page.getByRole('link', { name: 'View PR on GitHub' })).toHaveAttribute(
    'href',
    'https://github.com/example/repo/pull/123',
  );
  await expect(page.getByRole('button', { name: 'Mark own work done' })).toHaveCount(0);
});

for (const kind of ['manual', 'pr'] as const) {
  test(`${kind} PR gates show readiness, stale verification, and a direct GitHub link`, async ({
    page,
    request,
    context,
  }) => {
    const response = await request.post('/api/tasks', {
      data: { title: 'Merge release', kind, prUrl: 'https://github.com/example/api/pull/42' },
    });
    expect(response.ok()).toBeTruthy();
    const pr = (await response.json()) as TaskView;
    const snapshot = (await (await request.get('/api/state')).json()) as Snapshot;
    let state: PrState = 'open';
    let readiness: PrMergeStatus = 'ready';
    let error: string | null = null;
    await page.route('**/api/workspaces/default/state', (route) =>
      route.fulfill({
        json: {
          ...snapshot,
          tasks: snapshot.tasks.map((task) => ({
            ...task,
            prState: state,
            prMergeStatus: readiness,
            prError: error,
            prCheckedAt: '2026-09-08T12:00:00Z',
          })),
        },
      }),
    );
    await page.goto('/#/map');
    const card = node(page, pr.id);
    const link = card.getByRole('link', { name: 'Open PR for Merge release on GitHub' });
    await expect(link).toHaveAttribute('href', pr.prUrl!);
    await expect(link).toHaveAttribute('target', '_blank');
    await context.route(pr.prUrl!, (route) => route.fulfill({ body: 'Mock GitHub PR' }));
    const popupPromise = page.waitForEvent('popup');
    await link.click();
    const popup = await popupPromise;
    await expect(popup).toHaveURL(pr.prUrl!);
    await popup.close();
    await expect(page.getByRole('complementary', { name: 'Task details' })).toHaveCount(0);

    const cases: [PrState, PrMergeStatus, string][] = [
      ['open', 'ready', 'Ready to merge'],
      ['open', 'under_review', 'Under review'],
      ['open', 'checks_failing', 'Failing checks'],
      ['open', 'checks_pending', 'Checks pending'],
      ['open', 'draft', 'Draft'],
      ['open', 'changes_requested', 'Changes requested'],
      ['open', 'conflicts', 'Merge conflicts'],
      ['open', 'blocked', 'Merge blocked'],
      ['open', 'unknown', 'Readiness unknown'],
      ['unknown', 'unknown', 'Not checked'],
      ['closed', 'unknown', 'Closed unmerged'],
      ['merged', 'unknown', 'Merged'],
    ];
    for (const [prState, mergeStatus, label] of cases) {
      state = prState;
      readiness = mergeStatus;
      await page.reload();
      await expect(card.locator('.pr-status')).toHaveText(label);
      await card.locator('.node-title').click();
      const detail = page.getByRole('complementary', { name: 'Task details' });
      await expect(detail.locator('.pr-status')).toHaveText(label);
      await expect(detail.getByRole('button', { name: 'Mark own work done' })).toHaveCount(
        kind === 'manual' ? 1 : 0,
      );
      if (kind === 'manual') {
        await expect(card.locator('.node-manual-work')).toHaveText('Manual work not done');
        await expect(card.locator('.status')).toHaveText('Available');
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBeTruthy();
    }
    state = 'open';
    readiness = 'ready';
    error = 'GitHub request timed out.';
    await page.reload();
    await expect(card.locator('.pr-status')).toHaveText('Ready to merge (stale)');
    await expect(card.locator('.pr-status')).toHaveClass(/pr-status-warning/);
    await card.locator('.node-title').click();
    await expect(page.locator('.pr-detail .warning')).toContainText(error);
    await page.screenshot({ path: test.info().outputPath('pr-status.png'), fullPage: true });
  });
}

test('minimap highlights the selected node independently of completion', async ({
  page,
  request,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'Minimap is intentionally hidden on mobile.');
  const a = await create(request, 'Open step');
  const b = await create(request, 'Completed step');
  await request.post(`/api/tasks/${b.id}/done`, { data: { done: true } });
  await page.goto('/#/map');
  const miniNodes = page.locator('.react-flow__minimap-node');
  const selected = page.locator('.react-flow__minimap-node.selected');
  const canvas = page.locator('.graph-canvas');
  const widthBefore = (await canvas.boundingBox())!.width;
  await expect(miniNodes).toHaveCount(2);
  await expect(selected).toHaveCount(0);
  await node(page, a.id).locator('.node-title').click();
  await expect(page.locator('[data-slot="sheet-content"]')).toBeVisible();
  expect(Math.abs((await canvas.boundingBox())!.width - widthBefore)).toBeLessThan(1);
  await expect(miniNodes.nth(0)).toHaveCSS('fill', 'rgb(121, 99, 179)');
  await expect(miniNodes.nth(1)).toHaveCSS('fill', 'rgb(160, 183, 141)');
  await node(page, b.id).locator('.node-title').click();
  await expect(miniNodes.nth(0)).toHaveCSS('fill', 'rgb(215, 223, 206)');
  await expect(miniNodes.nth(1)).toHaveCSS('fill', 'rgb(121, 99, 179)');
  await expect(selected).toHaveCount(1);
  await page.getByRole('button', { name: 'Close task details' }).click();
  await expect(selected).toHaveCount(0);
  await expect(miniNodes.nth(1)).toHaveCSS('fill', 'rgb(160, 183, 141)');
});

test('manual layout persists, auto layout restores, and polling sees external updates', async ({
  request,
  page,
}, info) => {
  const parent = await create(request, 'Layout workspace', 'container');
  const a = await create(request, 'Arrange me', 'manual', parent.id);
  const b = await create(request, 'Another step', 'manual', parent.id);
  await page.goto(`/#/tasks/${parent.id}`);
  await page.getByRole('button', { name: 'Auto layout', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Manual layout', exact: true })).toBeVisible();
  if (info.project.name === 'desktop') {
    let box = await node(page, a.id).boundingBox();
    let previous = '';
    // Switching modes schedules fitView after 80ms, then animates for 250ms.
    await expect
      .poll(
        async () => {
          box = await node(page, a.id).boundingBox();
          const current = JSON.stringify(box);
          const stable = box !== null && current === previous;
          previous = current;
          return stable;
        },
        { intervals: [400] },
      )
      .toBe(true);
    expect(box).toBeTruthy();
    await page.mouse.move(box!.x + 70, box!.y + 30);
    await page.mouse.down();
    await page.mouse.move(box!.x + 160, box!.y + 100, { steps: 12 });
    await page.mouse.up();
    await expect
      .poll(
        async () =>
          ((await (await request.get('/api/state')).json()) as Snapshot).layouts[0].positions
            .length,
      )
      .toBe(2);
    const before = ((await (await request.get('/api/state')).json()) as Snapshot).layouts[0];
    await page.reload();
    await expect(page.getByRole('button', { name: 'Manual layout', exact: true })).toBeVisible();
    await expect(node(page, a.id)).toBeVisible();
    const restored = await node(page, a.id).evaluate((element) => {
      const matrix = new DOMMatrix(getComputedStyle(element).transform);
      return { x: matrix.e, y: matrix.f };
    });
    const saved = before.positions.find((position) => position.nodeId === a.id)!;
    expect(restored.x).toBeCloseTo(saved.x, 2);
    expect(restored.y).toBeCloseTo(saved.y, 2);
  }
  await page.getByRole('button', { name: 'Manual layout', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Auto layout', exact: true })).toBeVisible();
  await request.post(`/api/tasks/${b.id}/done`, { data: { done: true } });
  await expect(node(page, b.id).locator('.status')).toHaveText('Completed', { timeout: 8000 });
});

test('node handles connect and disconnect steps through the canvas', async ({ request, page }) => {
  const parent = await create(request, 'Canvas connections', 'container');
  const a = await create(request, 'Prerequisite', 'manual', parent.id);
  const b = await create(request, 'Dependent', 'manual', parent.id);
  await page.goto(`/#/tasks/${parent.id}`);
  await node(page, a.id).locator('.react-flow__handle.source').click();
  await node(page, b.id).locator('.react-flow__handle.target').click();
  await expect(node(page, b.id).locator('.status')).toHaveText('Blocked');
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  await expect(node(page, b.id)).toBeInViewport({ ratio: 1 });
  await node(page, b.id).hover();
  const midpoint = await page.locator('.react-flow__edge-interaction').evaluate((element) => {
    const path = element as SVGPathElement;
    const point = path.getPointAtLength(path.getTotalLength() / 2);
    const screen = new DOMPoint(point.x, point.y).matrixTransform(path.getScreenCTM()!);
    return { x: screen.x, y: screen.y };
  });
  await page.mouse.click(midpoint.x, midpoint.y);
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(node(page, b.id).locator('.status')).toHaveText('Available');
  await expect(page.locator('.react-flow__edge')).toHaveCount(0);
});

test('deletion rechecks changed impact and requires a fresh confirmation', async ({
  request,
  page,
}) => {
  const stage = await create(request, 'Stage', 'container');
  await create(request, 'Stage child', 'manual', stage.id);
  const prod = await create(request, 'Newly affected prod', 'container');
  await page.goto(`/#/tasks/${stage.id}`);
  await page.getByRole('button', { name: 'Delete container', exact: true }).click();
  const dialog = page.locator('.dialog');
  await expect(dialog).toContainText('No other tasks depend on this task.');
  await request.post('/api/references', { data: { containerId: prod.id, taskId: stage.id } });
  await dialog.getByRole('button', { name: 'Delete permanently' }).click();
  await expect(dialog.getByRole('alert')).toContainText('The graph changed');
  await expect(dialog).toContainText('Newly affected prod');
  const snapshot = (await (await request.get('/api/state')).json()) as Snapshot;
  expect(snapshot.tasks.some((task) => task.id === stage.id)).toBeTruthy();
  await dialog.getByRole('button', { name: 'Delete permanently' }).click();
  await expect(dialog).not.toBeVisible();
  const after = (await (await request.get('/api/state')).json()) as Snapshot;
  expect(after.tasks.some((task) => task.id === stage.id)).toBeFalsy();
  expect(after.tasks.some((task) => task.id === prod.id)).toBeTruthy();
});
