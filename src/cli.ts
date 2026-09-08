import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError, Option } from 'commander';
import type { DeletionPreview, Snapshot, TaskView, UpdateTaskInput } from './shared.js';

export async function main(argv = process.argv): Promise<void> {
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
  const request = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const url = new URL(`/api${path}`, serverUrl());
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
  const missingCommand = (command: string) => () => {
    throw new Error(`Specify a ${command}command. Run foggy ${command}--help for usage.`);
  };
  program.action(missingCommand(''));
  const task = program
    .command('task')
    .description('Create, inspect, and manage tasks')
    .action(missingCommand('task '));
  task
    .command('create <title>')
    .description('Create a task; IDs are assigned by the server')
    .addOption(
      new Option('--kind <kind>', 'task kind')
        .choices(['container', 'manual', 'pr'])
        .default('manual'),
    )
    .option('--parent <id>', 'owning container ID (omit for root)')
    .option('--pr <url>', 'GitHub pull request URL (required for PR tasks)')
    .option('--description <text>', 'task description')
    .action(async (title, options) =>
      output(
        await request('/tasks', 'POST', {
          title,
          kind: options.kind,
          parentId: options.parent,
          prUrl: options.pr,
          description: options.description,
        }),
      ),
    );
  task
    .command('list')
    .description('List tasks; parent filtering is ownership, not references')
    .option('--parent <id>', 'owning container ID, or root for unowned tasks')
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
          (options.status === undefined || task.status === options.status),
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
  task
    .command('update <id>')
    .description('Update editable fields; use --description "" to clear a description')
    .option('--title <title>', 'new title')
    .option('--description <text>', 'new description')
    .option('--pr <url>', 'new GitHub PR URL (resets verified PR state)')
    .action(async (id, options) => {
      const body: UpdateTaskInput = {
        title: options.title,
        description: options.description,
        prUrl: options.pr,
      };
      if (Object.values(body).every((value) => value === undefined))
        throw new Error('Provide at least one of --title, --description, or --pr.');
      output(await request(`/tasks/${encodeURIComponent(id)}`, 'PATCH', body));
    });
  for (const [name, done] of [
    ['done', true],
    ['reopen', false],
  ] as const) {
    task
      .command(`${name} <id>`)
      .description(
        `${done ? 'Satisfy' : 'Clear'} a manual task's own condition; completion is derived`,
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
    .command('ui')
    .description('Open the server UI in the default web browser')
    .action(async () => {
      const url = serverUrl().href;
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
