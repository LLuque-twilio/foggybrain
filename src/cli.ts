import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError, Option } from 'commander';
import type {
  ConnectTaskInput,
  CreateWorkspaceInput,
  DeletionPreview,
  Snapshot,
  SyncPreview,
  SyncStatus,
  Tag,
  TaskView,
  UpdateTaskInput,
  UpdateWorkspaceInput,
  Workspace,
  WorkspaceList,
} from './shared.js';
import {
  CONFIG_KEYS,
  applyConfigFile,
  assertConfigKey,
  assertConfigValue,
  configFilePath,
  describeSettings,
  loadConfigFile,
  readTokenFromGhCli,
  writeConfigFile,
  type ConfigValues,
  type LoadedConfig,
  type Setting,
} from './config.js';
import { dataDirectory, startServer, stopServer } from './daemon.js';
import {
  binDirectory,
  installRoot,
  linkVersion,
  packageVersion,
  uninstall,
  upgrade,
} from './install.js';

export async function main(argv = process.argv): Promise<void> {
  // `-v`/`--version` is recognized only as the first argument, handled before Commander
  // parsing rather than via `.version()`. Commander's global option scan otherwise claims
  // a registered `--version` wherever it appears in argv, which would swallow
  // `link --version`/`upgrade --version` before the subcommand ever sees it. It is
  // documented in `--help` (below) since it isn't a registered Commander option.
  if (argv[2] === '-v' || argv[2] === '--version') {
    process.stdout.write(`${packageVersion()}\n`);
    return;
  }
  // Before the options below read the environment for their defaults, and before `start` hands
  // it to the server it spawns. The process environment still wins over the file.
  let loaded: LoadedConfig;
  try {
    loaded = await loadConfigFile(configFilePath());
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`,
    );
    process.exitCode = 1;
    return;
  }
  // A warning rather than a failure: an entry this build cannot use must not lock the user out
  // of every command, least of all the one that would repair the file.
  for (const problem of loaded.problems)
    process.stderr.write(`Ignoring unusable setting in ${problem}\n`);
  applyConfigFile(process.env, loaded.values);
  const program = new Command();
  program
    .name('foggy')
    .description('Manage a running Foggybrain server. No local fallback state.')
    .option(
      '--url <url>',
      'server origin (or FOGGY_URL)',
      process.env.FOGGY_URL || 'http://127.0.0.1:4173',
    )
    .option('--json', 'print command results as JSON')
    .option(
      '--workspace <id>',
      'workspace ID (or FOGGY_WORKSPACE)',
      process.env.FOGGY_WORKSPACE || undefined,
    )
    .addHelpText(
      'after',
      '\n-v, --version    print the installed FoggyBrain version (must be the first argument)',
    )
    .showSuggestionAfterError(false)
    .configureOutput({ writeErr: () => {} })
    .exitOverride();

  const output = (value: unknown): void => {
    process.stdout.write(`${JSON.stringify(value)}\n`);
  };
  const serverUrl = () => {
    let url: URL;
    try {
      url = new URL(program.opts().url);
    } catch {
      throw new Error('--url / FOGGY_URL must be an absolute HTTP(S) server origin.');
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    ) {
      throw new Error(
        '--url / FOGGY_URL must be an HTTP(S) origin without credentials, path, query, or fragment.',
      );
    }
    return url;
  };
  const request = async <T>(
    path: string,
    method = 'GET',
    body?: unknown,
    scoped = true,
  ): Promise<T> => {
    const workspace = program.opts().workspace;
    if (scoped && workspace !== undefined && !workspace.trim())
      throw new Error('--workspace / FOGGY_WORKSPACE must be a nonempty workspace ID.');
    if (scoped && (workspace === '.' || workspace === '..'))
      throw new Error('Invalid workspace ID.');
    const prefix =
      scoped && workspace !== undefined ? `/workspaces/${encodeURIComponent(workspace)}` : '';
    const url = new URL(`/api${prefix}${path}`, serverUrl());
    let response: Response;
    let text: string;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
      });
      text = await response.text();
    } catch (error) {
      throw new Error(
        `Cannot reach Foggybrain at ${url.origin}: ${error instanceof Error ? error.message : String(error)}. Check the running server and --url / FOGGY_URL.`,
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error(
        `HTTP ${response.status}: server returned non-JSON data. Check --url / FOGGY_URL.`,
      );
    }
    if (!response.ok) {
      const message =
        value && typeof value === 'object' && 'error' in value && typeof value.error === 'string'
          ? value.error
          : response.statusText;
      throw new Error(`HTTP ${response.status}: ${message}`);
    }
    return value as T;
  };
  const state = () => request<Snapshot>('/state');
  const taskFrom = (snapshot: Snapshot, id: string) => {
    const task = snapshot.tasks.find((task) => task.id === id);
    if (!task) throw new Error(`Task not found: ${id}`);
    return task;
  };
  const printTasks = (tasks: TaskView[]) => {
    if (!tasks.length) process.stdout.write('(no tasks)\n');
    for (const task of tasks) {
      process.stdout.write(
        `${task.id}\t${task.status}\t${task.kind}\t${JSON.stringify(task.title)}\tparent=${task.parentId ?? 'root'}\n`,
      );
    }
  };
  const collectTag = (value: string, previous: string[] = []): string[] => [...previous, value];
  const taskTagOptions = (command: Command): Command =>
    command
      .option('--tag <id>', 'replace all custom tags (repeatable, up to 3)', collectTag)
      .addOption(new Option('--star', 'add the Favorites tag').conflicts('unstar'))
      .addOption(new Option('--unstar', 'remove the Favorites tag').conflicts('star'));
  const customTagIds = (options: { tag?: string[] }): string[] | undefined => {
    if (options.tag === undefined) return undefined;
    if (options.tag.includes('favorites'))
      throw new Error('Use --star or --unstar to change the Favorites tag.');
    if (options.tag.length > 3) throw new Error('A task can have at most 3 custom tags.');
    return options.tag;
  };
  const updateStar = (id: string, options: { star?: boolean; unstar?: boolean }) =>
    options.star
      ? request<TaskView>(`/tasks/${encodeURIComponent(id)}/tags/favorites`, 'PUT', {})
      : options.unstar
        ? request<TaskView>(`/tasks/${encodeURIComponent(id)}/tags/favorites`, 'DELETE')
        : undefined;
  const missingCommand = (command: string) => () => {
    throw new Error(`Specify a ${command}command. Run foggy ${command}--help for usage.`);
  };
  program.action(missingCommand(''));
  const workspace = program
    .command('workspace')
    .description('Manage up to three local or local-first cloud workspaces')
    .action(missingCommand('workspace '));
  workspace
    .command('list')
    .description('List workspaces, the default workspace ID, and the server limit')
    .action(async () =>
      output(await request<WorkspaceList>('/workspaces', 'GET', undefined, false)),
    );
  workspace
    .command('rename <id> <name>')
    .description('Rename a workspace without changing its target')
    .action(async (id, name) =>
      output(
        await request<Workspace>(
          `/workspaces/${encodeURIComponent(id)}`,
          'PATCH',
          { name } satisfies UpdateWorkspaceInput,
          false,
        ),
      ),
    );
  for (const name of ['create', 'connect'] as const) {
    const command = workspace
      .command(name === 'create' ? 'create <name>' : 'connect <id>')
      .description(
        name === 'create'
          ? 'Create a workspace; does not access remote state'
          : 'Connect a local workspace to cloud; no remote access or cloud retargeting',
      )
      .option('--repo <owner/repo>', 'existing private state repository (required for cloud)')
      .option('--branch <branch>', 'existing branch (cloud default: main)')
      .option('--path <path>', 'state JSON path (cloud default: foggybrain/state.json)')
      .addOption(
        new Option(
          '--credential <source>',
          'server credential (cloud default: dedicated); github explicitly reuses GitHub auth',
        ).choices(['dedicated', 'github']),
      );
    if (name === 'create')
      command.addOption(
        new Option('--type <type>', 'workspace type').choices(['local', 'cloud']).default('local'),
      );
    command.action(async (value, options) => {
      const type = name === 'connect' ? 'cloud' : options.type;
      if (
        type === 'local' &&
        [options.repo, options.branch, options.path, options.credential].some(
          (value) => value !== undefined,
        )
      )
        throw new Error('Cloud configuration requires --type cloud.');
      if (type === 'cloud' && !options.repo)
        throw new Error('Cloud configuration requires --repo.');
      const configuration =
        type === 'cloud'
          ? {
              target: {
                repo: options.repo,
                branch: options.branch ?? 'main',
                path: options.path ?? 'foggybrain/state.json',
              },
              credential: options.credential ?? 'dedicated',
            }
          : {};
      const body: CreateWorkspaceInput | UpdateWorkspaceInput =
        name === 'create'
          ? { name: value, type, ...configuration }
          : { type: 'cloud', ...configuration };
      output(
        await request<Workspace>(
          name === 'create' ? '/workspaces' : `/workspaces/${encodeURIComponent(value)}`,
          name === 'create' ? 'POST' : 'PATCH',
          body,
          false,
        ),
      );
    });
  }
  const task = program
    .command('task')
    .description('Create, inspect, and manage tasks')
    .action(missingCommand('task '));
  taskTagOptions(task.command('create <title>'))
    .description('Create a task; IDs are assigned by the server')
    .addOption(
      new Option('--kind <kind>', 'task kind')
        .choices(['container', 'manual', 'pr'])
        .default('manual'),
    )
    .option('--parent <id>', 'owning container ID (omit for root)')
    .option('--pr <url>', 'GitHub pull request URL (optional manual gate; required for PR tasks)')
    .option('--description <text>', 'task description')
    .action(async (title, options) => {
      const created = await request<TaskView>('/tasks', 'POST', {
        title,
        kind: options.kind,
        parentId: options.parent,
        prUrl: options.pr,
        description: options.description,
        tagIds: customTagIds(options),
      });
      output((await updateStar(created.id, options)) ?? created);
    });
  task
    .command('connect <id>')
    .description('Atomically connect an existing/new task or insert it into one dependency edge')
    .addOption(
      new Option('--direction <direction>', 'connection relative to the anchor task')
        .choices(['prerequisite', 'dependent'])
        .makeOptionMandatory(),
    )
    .option('--task <id>', 'existing task ID (mutually exclusive with creation flags)')
    .option('--title <title>', 'create and connect a new task with this title')
    .addOption(
      new Option('--kind <kind>', 'new task kind (default: manual)').choices([
        'container',
        'manual',
        'pr',
      ]),
    )
    .option('--parent <id>', 'new task owning container ID (omit for root)')
    .option('--pr <url>', 'new task GitHub PR URL (optional manual gate; required for PR tasks)')
    .option('--description <text>', 'new task description')
    .option('--dependency <id>', 'dependency relationship ID to split instead of adding a leaf')
    .action(async (id, options) => {
      if ((options.task === undefined) === (options.title === undefined))
        throw new Error('Provide exactly one of --task or --title.');
      if (
        options.task !== undefined &&
        [options.kind, options.parent, options.pr, options.description].some(
          (value) => value !== undefined,
        )
      )
        throw new Error('--kind, --parent, --pr, and --description require --title, not --task.');
      const body: ConnectTaskInput = {
        direction: options.direction,
        dependencyId: options.dependency,
        ...(options.task !== undefined
          ? { taskId: options.task }
          : {
              task: {
                title: options.title,
                kind: options.kind ?? 'manual',
                parentId: options.parent,
                prUrl: options.pr,
                description: options.description,
              },
            }),
      };
      output(await request<TaskView>(`/tasks/${encodeURIComponent(id)}/connections`, 'POST', body));
    });
  task
    .command('list')
    .description('List tasks; parent filtering is ownership, not references')
    .option('--parent <id>', 'owning container ID, or root for unowned tasks')
    .option('--tag <id>', 'match any tag ID (repeatable)', collectTag)
    .option('--starred', 'match tasks with the Favorites tag')
    .addOption(
      new Option('--status <status>', 'derived task status').choices([
        'available',
        'blocked',
        'ready',
        'completed',
      ]),
    )
    .action(async (options) => {
      const snapshot = await state();
      if (
        options.parent !== undefined &&
        options.parent !== 'root' &&
        taskFrom(snapshot, options.parent).kind !== 'container'
      ) {
        throw new Error(`Not a container: ${options.parent}`);
      }
      const tasks = snapshot.tasks.filter(
        (task) =>
          (options.parent === undefined ||
            task.parentId === (options.parent === 'root' ? null : options.parent)) &&
          (options.status === undefined || task.status === options.status) &&
          ((options.tag === undefined && !options.starred) ||
            [...(options.tag ?? []), ...(options.starred ? ['favorites'] : [])].some((tagId) =>
              task.tagIds.includes(tagId),
            )),
      );
      if (program.opts().json) output(tasks);
      else printTasks(tasks);
    });
  task
    .command('show <id>')
    .description('Full task plus children, prerequisites, dependents, and relationship records')
    .action(async (id) => {
      const snapshot = await state();
      const task = taskFrom(snapshot, id);
      const dependencies = snapshot.dependencies.filter(
        (edge) => edge.prerequisiteId === id || edge.dependentId === id,
      );
      output({
        ...task,
        tags: snapshot.tags.filter((tag) => task.tagIds.includes(tag.id)),
        children: snapshot.tasks.filter((child) => task.childrenIds.includes(child.id)),
        prerequisites: snapshot.tasks.filter((candidate) =>
          dependencies.some(
            (edge) => edge.dependentId === id && edge.prerequisiteId === candidate.id,
          ),
        ),
        dependents: snapshot.tasks.filter((candidate) =>
          dependencies.some(
            (edge) => edge.prerequisiteId === id && edge.dependentId === candidate.id,
          ),
        ),
        dependencies,
        references: snapshot.references.filter(
          (reference) => reference.containerId === id || reference.taskId === id,
        ),
      });
    });
  taskTagOptions(task.command('update <id>'))
    .description('Update editable fields; use --description "" to clear a description')
    .option('--title <title>', 'new title')
    .option('--description <text>', 'new description')
    .option('--pr <url>', 'new GitHub PR URL (resets verified PR state)')
    .addOption(new Option('--remove-pr', 'remove an optional manual PR gate').conflicts('pr'))
    .action(async (id, options) => {
      const body: UpdateTaskInput = {
        title: options.title,
        description: options.description,
        prUrl: options.removePr ? null : options.pr,
      };
      const tagIds = customTagIds(options);
      if (
        Object.values(body).every((value) => value === undefined) &&
        tagIds === undefined &&
        !options.star &&
        !options.unstar
      )
        throw new Error(
          'Provide at least one of --title, --description, --pr, --remove-pr, --tag, --star, or --unstar.',
        );
      let updated: TaskView | undefined;
      if (Object.values(body).some((value) => value !== undefined))
        updated = await request<TaskView>(`/tasks/${encodeURIComponent(id)}`, 'PATCH', body);
      if (tagIds !== undefined)
        updated = await request<TaskView>(`/tasks/${encodeURIComponent(id)}/tags`, 'PUT', {
          tagIds,
        });
      updated = (await updateStar(id, options)) ?? updated;
      output(updated);
    });
  for (const [name, done] of [
    ['done', true],
    ['reopen', false],
  ] as const) {
    task
      .command(`${name} <id>`)
      .description(
        `${done ? 'Satisfy' : 'Clear'} manual work; attached PR gates and prerequisites still apply`,
      )
      .action(async (id) =>
        output(await request(`/tasks/${encodeURIComponent(id)}/done`, 'POST', { done })),
      );
  }
  task
    .command('delete <id>')
    .description('Preview cascading deletion and require confirmation')
    .option('--dry-run', 'return the deletion preview without deleting or prompting')
    .option('--yes', 'explicitly confirm deletion without a prompt')
    .action(async (id, options) => {
      const path = `/tasks/${encodeURIComponent(id)}`;
      const preview = await request<DeletionPreview>(`${path}/deletion-preview`);
      const snapshot = await state();
      const tasks = preview.taskIds.map((taskId) => taskFrom(snapshot, taskId));
      if (options.dryRun) {
        output({ ...preview, tasks });
        return;
      }
      if (!options.yes) {
        if (!process.stdin.isTTY || !process.stderr.isTTY) {
          throw new Error(
            'Deletion requires --yes without a terminal. Inspect task delete <id> --dry-run first.',
          );
        }
        process.stderr.write('Will delete these owned tasks:\n');
        for (const task of tasks)
          process.stderr.write(`  ${task.id}\t${JSON.stringify(task.title)}\n`);
        process.stderr.write('Affected tasks (completion may change):\n');
        for (const task of preview.affectedTasks)
          process.stderr.write(`  ${task.id}\t${JSON.stringify(task.title)}\n`);
        if (!preview.affectedTasks.length) process.stderr.write('  (none)\n');
        process.stderr.write(
          `Removing ${preview.removedDependencies.length} dependencies and ${preview.removedReferences.length} references. Reference targets are not deleted unless also owned descendants.\n`,
        );
        const terminal = createInterface({ input: process.stdin, output: process.stderr });
        const cancelled = new AbortController();
        terminal.once('close', () => cancelled.abort());
        terminal.once('SIGINT', () => cancelled.abort());
        let answer: string;
        try {
          answer = await terminal.question('Delete these tasks? Type yes to confirm: ', {
            signal: cancelled.signal,
          });
        } catch (error) {
          if (cancelled.signal.aborted) throw new Error('Deletion cancelled.');
          throw error;
        } finally {
          terminal.close();
        }
        if (answer.trim().toLowerCase() !== 'yes') throw new Error('Deletion cancelled.');
      }
      output(await request(`${path}?confirm=true`, 'DELETE'));
    });

  const tag = program
    .command('tag')
    .description('Create and manage workspace tags')
    .action(missingCommand('tag '));
  tag
    .command('create <name>')
    .description('Create a custom tag')
    .requiredOption('--color <hex>', 'tag color as #RRGGBB')
    .action(async (name, options) =>
      output(await request<Tag>('/tags', 'POST', { name, color: options.color })),
    );
  tag
    .command('list')
    .description('List workspace tags, including Favorites')
    .action(async () => output((await state()).tags));
  tag
    .command('update <id>')
    .description('Rename or recolor a custom tag')
    .option('--name <name>', 'new tag name')
    .option('--color <hex>', 'new tag color as #RRGGBB')
    .action(async (id, options) => {
      const body = { name: options.name, color: options.color };
      if (Object.values(body).every((value) => value === undefined))
        throw new Error('Provide at least one of --name or --color.');
      output(await request<Tag>(`/tags/${encodeURIComponent(id)}`, 'PATCH', body));
    });
  tag
    .command('delete <id>')
    .description('Preview task detachments and require confirmation')
    .option('--dry-run', 'return the deletion preview without deleting or prompting')
    .option('--yes', 'explicitly confirm deletion without a prompt')
    .action(async (id, options) => {
      const path = `/tags/${encodeURIComponent(id)}`;
      const preview = await request<{ tag: Tag; affectedTasks: TaskView[] }>(
        `${path}/deletion-preview`,
      );
      if (options.dryRun) {
        output(preview);
        return;
      }
      if (!options.yes) {
        if (!process.stdin.isTTY || !process.stderr.isTTY)
          throw new Error(
            'Tag deletion requires --yes without a terminal. Inspect tag delete <id> --dry-run first.',
          );
        process.stderr.write(
          `Will delete tag ${preview.tag.id}\t${JSON.stringify(preview.tag.name)} and detach it from these tasks:\n`,
        );
        for (const task of preview.affectedTasks)
          process.stderr.write(`  ${task.id}\t${JSON.stringify(task.title)}\n`);
        if (!preview.affectedTasks.length) process.stderr.write('  (none)\n');
        const terminal = createInterface({ input: process.stdin, output: process.stderr });
        const cancelled = new AbortController();
        terminal.once('close', () => cancelled.abort());
        terminal.once('SIGINT', () => cancelled.abort());
        let answer: string;
        try {
          answer = await terminal.question('Delete this tag? Type yes to confirm: ', {
            signal: cancelled.signal,
          });
        } catch (error) {
          if (cancelled.signal.aborted) throw new Error('Deletion cancelled.');
          throw error;
        } finally {
          terminal.close();
        }
        if (answer.trim().toLowerCase() !== 'yes') throw new Error('Deletion cancelled.');
      }
      output(await request(`${path}?confirm=true`, 'DELETE'));
    });

  const dependency = program
    .command('dependency')
    .description('Completion prerequisites')
    .action(missingCommand('dependency '));
  dependency
    .command('add <prerequisite> <dependent>')
    .description('The dependent completes only after the prerequisite completes')
    .action(async (prerequisiteId, dependentId) =>
      output(await request('/dependencies', 'POST', { prerequisiteId, dependentId })),
    );
  dependency
    .command('remove <id>')
    .description('Remove a dependency by its relationship ID')
    .action(async (id) =>
      output(await request(`/dependencies/${encodeURIComponent(id)}`, 'DELETE')),
    );

  const reference = program
    .command('reference')
    .description('Shared child membership without changing ownership')
    .action(missingCommand('reference '));
  reference
    .command('add <container> <task>')
    .description('Reference an existing task as a child of a container')
    .action(async (containerId, taskId) =>
      output(await request('/references', 'POST', { containerId, taskId })),
    );
  reference
    .command('remove <id>')
    .description('Unlink a reference by its relationship ID; keep the task')
    .action(async (id) => output(await request(`/references/${encodeURIComponent(id)}`, 'DELETE')));

  program
    .command('graph [container-id]')
    .description('Show all tasks, or a container and its transitive owned/referenced children')
    .action(async (containerId) => {
      const snapshot = await state();
      let graph = { viewId: containerId ?? 'root', ...snapshot };
      if (containerId !== undefined) {
        const container = taskFrom(snapshot, containerId);
        if (container.kind !== 'container') throw new Error(`Not a container: ${containerId}`);
        const ids = new Set<string>();
        const pending = [containerId];
        while (pending.length) {
          const id = pending.pop()!;
          if (ids.has(id)) continue;
          ids.add(id);
          pending.push(...taskFrom(snapshot, id).childrenIds);
        }
        graph = {
          viewId: containerId,
          tasks: snapshot.tasks.filter((task) => ids.has(task.id)),
          tags: snapshot.tags,
          dependencies: snapshot.dependencies.filter(
            (edge) => ids.has(edge.prerequisiteId) && ids.has(edge.dependentId),
          ),
          references: snapshot.references.filter(
            (reference) => ids.has(reference.containerId) && ids.has(reference.taskId),
          ),
          layouts: snapshot.layouts.filter((layout) => ids.has(layout.viewId)),
        };
      }
      if (program.opts().json) output(graph);
      else {
        printTasks(graph.tasks);
        process.stdout.write('Dependencies (prerequisite -> dependent):\n');
        for (const edge of graph.dependencies)
          process.stdout.write(`${edge.id}\t${edge.prerequisiteId} -> ${edge.dependentId}\n`);
        process.stdout.write('References (container -> shared child):\n');
        for (const reference of graph.references)
          process.stdout.write(
            `${reference.id}\t${reference.containerId} -> ${reference.taskId}\n`,
          );
      }
    });

  const sync = program
    .command('sync')
    .description('Preview and explicitly apply server-side state sync')
    .action(missingCommand('sync '));
  sync
    .command('status')
    .description('Inspect state sync configuration and local dirty status')
    .action(async () => output(await request<SyncStatus>('/sync/status')));
  sync
    .command('preview')
    .description('Inspect changes and conflicts; check canApply and validationError')
    .addOption(
      new Option('--resolve <side>', 'choose a side for conflicts').choices(['local', 'remote']),
    )
    .addOption(
      new Option(
        '--revert',
        'preview replacing local state from origin without GitHub writes',
      ).conflicts('resolve'),
    )
    .action(async (options) =>
      output(
        await request<SyncPreview>('/sync/preview', 'POST', {
          resolution: options.resolve,
          mode: options.revert ? 'revert' : undefined,
        }),
      ),
    );
  sync
    .command('apply <preview-id>')
    .description('Apply a reviewed preview; never generates a preview or prompts')
    .option('--yes', 'explicitly confirm applying this preview')
    .action(async (previewId, options) => {
      if (!options.yes)
        throw new Error('State sync apply requires --yes. Inspect sync preview before confirming.');
      output(await request<SyncStatus>('/sync/apply', 'POST', { previewId, confirm: true }));
    });

  const github = program
    .command('github')
    .description('Server-side GitHub connection and polling')
    .action(missingCommand('github '));
  for (const name of ['status', 'prs', 'sync'] as const) {
    github
      .command(name)
      .description(
        name === 'sync'
          ? 'Request a sync; inspect the returned error and syncing fields'
          : name === 'prs'
            ? 'List cached authored open PRs'
            : 'Inspect GitHub configuration and sync status',
      )
      .action(async () =>
        output(await request(`/github/${name}`, name === 'sync' ? 'POST' : 'GET')),
      );
  }
  program
    .command('link')
    .description('Point the foggy executable and current version at an installed version')
    .option('--version <version>', 'installed version (default: this CLI version)')
    .option('--force', 'replace a foggy executable that belongs to another installation')
    .action(async (options) =>
      output(
        await linkVersion({ version: options.version ?? packageVersion(), force: options.force }),
      ),
    );
  program
    .command('upgrade')
    .description('Download a FoggyBrain release and switch this installation to it')
    .option('--version <version>', 'release version (default: latest)')
    .option('--force', 'replace a foggy executable that belongs to another installation')
    .action(async (options) =>
      output(await upgrade({ version: options.version, force: options.force })),
    );
  program
    .command('uninstall')
    .description('Remove the installed foggy executable, its PATH entry, and ~/.foggybrain')
    .option('--yes', 'explicitly confirm removal without a prompt')
    .action(async (options) => {
      const root = installRoot();
      if (!options.yes) {
        if (!process.stdin.isTTY || !process.stderr.isTTY)
          throw new Error('Uninstall requires --yes without a terminal.');
        process.stderr.write(
          `Will remove ${root}, ${join(binDirectory(), 'foggy')}, and the FoggyBrain PATH entry.\nTask data in ${dataDirectory()} and settings in ${configFilePath()} are kept.\n`,
        );
        const terminal = createInterface({ input: process.stdin, output: process.stderr });
        let answer: string;
        try {
          answer = await terminal.question('Uninstall FoggyBrain? Type yes to confirm: ');
        } finally {
          terminal.close();
        }
        if (answer.trim().toLowerCase() !== 'yes') throw new Error('Uninstall cancelled.');
      }
      output(await uninstall());
    });
  // Consulted only when nothing else supplies a token, so `list` explains a server that
  // authenticates with no token in sight without paying for a subprocess every time.
  const ghToken = () => readTokenFromGhCli() !== undefined;
  const settings = async (showSecrets: boolean): Promise<Setting[]> =>
    describeSettings(process.env, (await loadConfigFile(configFilePath())).values, {
      ghToken,
      showSecrets,
    });
  const setting = async (name: string, showSecrets: boolean): Promise<Setting> =>
    (await settings(showSecrets)).find((entry) => entry.name === name)!;
  /** Reports a saved value from the file rather than from this process, whose environment was
   * resolved before the write. */
  const saved = (values: ConfigValues, name: string, showSecrets: boolean): Setting =>
    describeSettings({}, values, { ghToken: false, showSecrets }).find(
      (entry) => entry.name === name,
    )!;
  /** Loads for a command that is about to rewrite the file, announcing entries it will drop. */
  const editable = async (): Promise<ConfigValues> => {
    const { values, problems } = await loadConfigFile(configFilePath());
    if (problems.length > 0)
      process.stderr.write(
        `Saving without ${problems.length} unusable ${problems.length === 1 ? 'entry' : 'entries'} in ${configFilePath()}\n`,
      );
    return values;
  };
  const printSettings = (rows: Setting[]): void => {
    const width = Math.max(...rows.map((row) => row.name.length));
    for (const row of rows)
      process.stdout.write(
        `${row.name.padEnd(width)}  ${(row.value ?? '<unset>').padEnd(28)}  (${row.source})\n`,
      );
  };
  const config = program
    .command('config')
    .description(`Read and write the settings saved in ${configFilePath()}`)
    .option('--show-secrets', 'print token values instead of masking them')
    .action(async (options) => {
      const values = await editable();
      const terminal = createInterface({ input: process.stdin, output: process.stderr });
      // Pulling lines from the iterator rather than awaiting `question`: at end of input the
      // iterator reports it, where a pending `question` would race the interface closing.
      const lines = terminal[Symbol.asyncIterator]();
      try {
        for (const key of CONFIG_KEYS) {
          const current = values[key.name];
          const shown = current === undefined ? '' : key.secret ? ' [****]' : ` [${current}]`;
          process.stderr.write(`${key.label}${shown}: `);
          const answer = await lines.next();
          // End of input keeps every remaining value rather than clearing the file.
          if (answer.done) break;
          const trimmed = answer.value.trim();
          if (trimmed === '') continue;
          if (trimmed === '-') delete values[key.name];
          else {
            assertConfigValue(key.name, trimmed);
            values[key.name] = trimmed;
          }
        }
      } finally {
        terminal.close();
      }
      await writeConfigFile(values, configFilePath());
      process.stderr.write(`Saved ${configFilePath()}\n`);
      if (program.opts().json)
        output(
          describeSettings({}, values, { ghToken, showSecrets: options.showSecrets === true }),
        );
    });
  config
    .command('list')
    .description('Show every setting with the source of its current value')
    .action(async () => {
      const rows = await settings(config.opts().showSecrets === true);
      if (program.opts().json) output(rows);
      else printSettings(rows);
    });
  config
    .command('get <key>')
    .description('Show one setting and where its value comes from')
    .action(async (name) => {
      assertConfigKey(name);
      const row = await setting(name, config.opts().showSecrets === true);
      if (program.opts().json) output(row);
      else printSettings([row]);
    });
  config
    .command('set <key> <value>')
    .description('Save one setting to the configuration file')
    .action(async (name, value) => {
      assertConfigValue(name, value);
      const values = await editable();
      values[name] = value;
      await writeConfigFile(values, configFilePath());
      const row = saved(values, name, config.opts().showSecrets === true);
      if (program.opts().json) output(row);
      else printSettings([row]);
    });
  config
    .command('unset <key>')
    .description('Remove one setting from the configuration file')
    .action(async (name) => {
      assertConfigKey(name);
      const values = await editable();
      const removed = name in values;
      delete values[name];
      if (removed) await writeConfigFile(values, configFilePath());
      output({ name, removed });
    });
  program
    .command('start')
    .description('Start the Foggybrain server in the background')
    .action(async () => output(await startServer()));
  program
    .command('stop')
    .description('Stop the background Foggybrain server')
    .action(async () => output(await stopServer()));
  program
    .command('dashboard')
    .description('Open the server UI in the default web browser')
    .action(async () => {
      const target = serverUrl();
      const workspace = program.opts().workspace;
      if (workspace !== undefined) {
        if (!workspace.trim())
          throw new Error('--workspace / FOGGY_WORKSPACE must be a nonempty workspace ID.');
        target.searchParams.set('workspace', workspace);
      }
      const url = target.href;
      // Passing the URL as an argument avoids shell interpretation of untrusted input.
      const executable =
        process.platform === 'darwin'
          ? 'open'
          : process.platform === 'win32'
            ? 'rundll32.exe'
            : 'xdg-open';
      const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
      await new Promise<void>((resolve, reject) => {
        const child = spawn(executable, args, { shell: false, stdio: 'ignore' });
        child.once('error', reject);
        child.once('close', (code) =>
          code === 0
            ? resolve()
            : reject(new Error(`Browser opener exited with status ${code}. Open ${url} manually.`)),
        );
      });
      output({ url, opened: true });
    });

  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return;
    process.stderr.write(
      `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`,
    );
    process.exitCode = 1;
  }
}

// The installed bin imports the compiled CLI rather than calling main itself.
if (process.argv[1] && existsSync(process.argv[1])) {
  const entry = realpathSync(process.argv[1]);
  if (
    entry === fileURLToPath(import.meta.url) ||
    entry === fileURLToPath(new URL('../../bin/foggy.mjs', import.meta.url))
  ) {
    await main();
  }
}
