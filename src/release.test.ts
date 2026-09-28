import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test, type TestContext } from 'node:test';

const execFileAsync = promisify(execFile);
const validator = fileURLToPath(new URL('../scripts/validate-release-stage.mjs', import.meta.url));

async function scratch(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'foggy-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('release stage validator accepts symlinks that resolve inside the stage', async (t) => {
  const root = await scratch(t);
  const stage = join(root, 'stage');
  await mkdir(join(stage, 'package'), { recursive: true });
  await writeFile(join(stage, 'package', 'entry.js'), 'export {};\n');
  await symlink('entry.js', join(stage, 'package', 'first.js'));
  await symlink('first.js', join(stage, 'package', 'second.js'));

  const result = await execFileAsync(process.execPath, [validator, stage]);

  assert.match(result.stdout, /Validated 2 release stage symlinks/);
  assert.equal(result.stderr, '');
});

test('release stage validator rejects relative symlinks outside the stage', async (t) => {
  const root = await scratch(t);
  const stage = join(root, 'stage');
  await mkdir(stage);
  await writeFile(join(root, 'secret'), 'not for release\n');
  await symlink('../secret', join(stage, 'dependency'));

  await assert.rejects(execFileAsync(process.execPath, [validator, stage]), (error: unknown) => {
    assert.ok(error && typeof error === 'object' && 'stderr' in error);
    assert.match(String(error.stderr), /symlink escapes the stage/);
    return true;
  });
});

test('release stage validator rejects dangling symlinks', async (t) => {
  const root = await scratch(t);
  const stage = join(root, 'stage');
  await mkdir(stage);
  await symlink('missing', join(stage, 'dependency'));

  await assert.rejects(execFileAsync(process.execPath, [validator, stage]), (error: unknown) => {
    assert.ok(error && typeof error === 'object' && 'stderr' in error);
    assert.match(String(error.stderr), /unresolvable symlink/);
    return true;
  });
});
