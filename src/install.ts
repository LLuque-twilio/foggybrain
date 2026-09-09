import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The compiled CLI lives in dist/server/, the source in src/; package.json sits one level further up
// from the compiled tree.
const manifestUrl = new URL(
  import.meta.url.endsWith('.ts') ? '../package.json' : '../../package.json',
  import.meta.url,
);

export function packageVersion(): string {
  const manifest: unknown = JSON.parse(readFileSync(fileURLToPath(manifestUrl), 'utf8'));
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    !('version' in manifest) ||
    typeof manifest.version !== 'string'
  )
    throw new Error('package.json is missing a string version.');
  return manifest.version;
}
