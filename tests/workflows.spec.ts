import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Snapshot, TaskView } from '../src/shared';

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
  const dialog = page.getByRole('dialog');
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
    'Workspace',
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
  await breadcrumbs.getByRole('button', { name: 'Workspace', exact: true }).click();
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
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: /Ship to stage/ }).click();
  await dialog.getByRole('button', { name: 'Link task', exact: true }).click();
  await expect(node(page, stage.id)).toBeVisible();
  await node(page, smoke.id).click();
  await page.getByLabel('Add prerequisite').selectOption(stage.id);
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

test('authored PR dropdown creates a merge step and preserves custom summaries', async ({
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
  await page.route('**/api/github/prs', (route) => route.fulfill({ json: prs }));
  await page.route('**/api/github/status', (route) =>
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
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'PR merge', exact: true }).click();
  const picker = dialog.getByLabel('Your open pull requests');
  await expect(picker.locator('option')).toHaveText([
    'Select a PR or enter a URL below',
    'example/api #42: Improve API',
    'example/web #42: Improve web (draft)',
  ]);
  await picker.selectOption(prs[0].url);
  await expect(dialog.getByLabel('Summary')).toHaveValue('Merge Improve API');
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
    kind: 'pr',
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

test('PR dropdown reports empty and stale GitHub results without blocking URL entry', async ({
  page,
}) => {
  await page.route('**/api/github/prs', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/github/status', (route) =>
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
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('No authored open pull requests found.');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.route('**/api/github/status', (route) =>
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

test('invalid PR errors stay inside dialog, PR tab works without credentials', async ({ page }) => {
  await page.goto('/#/prs');
  await expect(page.getByText('Connect GitHub when you are ready.')).toBeVisible();
  await page.getByRole('button', { name: 'Link a PR by URL' }).click();
  const dialog = page.getByRole('dialog');
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
    const box = await node(page, a.id).boundingBox();
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
  const dialog = page.getByRole('dialog');
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
