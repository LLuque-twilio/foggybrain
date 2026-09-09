import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { packageVersion } from './install.js';

test('packageVersion reads the version from package.json', () => {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as { version: string };
  assert.equal(packageVersion(), manifest.version);
  assert.match(packageVersion(), /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
});
