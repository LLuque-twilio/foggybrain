#!/usr/bin/env node

import { lstat, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const stage = process.argv[2];

if (!stage) {
  console.error('Usage: node scripts/validate-release-stage.mjs <stage-directory>');
  process.exit(1);
}

const stagePath = resolve(stage);
const stageStat = await lstat(stagePath).catch(() => null);

if (!stageStat?.isDirectory()) {
  console.error(`Release stage is not a directory: ${stagePath}`);
  process.exit(1);
}

const stageRoot = await realpath(stagePath);
let linkCount = 0;

function isInsideStage(path) {
  const fromStage = relative(stageRoot, path);
  return (
    fromStage === '' ||
    (!isAbsolute(fromStage) && fromStage !== '..' && !fromStage.startsWith(`..${sep}`))
  );
}

async function inspect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const path = resolve(directory, entry.name);

    if (entry.isSymbolicLink()) {
      linkCount += 1;

      let target;
      try {
        target = await realpath(path);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Release stage contains an unresolvable symlink: ${path} (${reason})`);
      }

      if (!isInsideStage(target)) {
        throw new Error(`Release stage symlink escapes the stage: ${path} -> ${target}`);
      }
    } else if (entry.isDirectory()) {
      await inspect(path);
    }
  }
}

try {
  await inspect(stageRoot);
  console.log(`Validated ${linkCount} release stage symlink${linkCount === 1 ? '' : 's'}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
