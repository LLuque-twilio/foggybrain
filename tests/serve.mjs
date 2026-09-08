import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../dist/server/server.js';

const directory = await mkdtemp(join(tmpdir(), 'foggybrain-browser-'));
process.env.FOGGY_DATA_DIR = directory;
process.env.FOGGY_PORT = '4189';
process.env.GH_TOKEN = '';
process.env.GITHUB_TOKEN = '';
process.env.GH_CONFIG_DIR = directory;
for (const key of ['FOGGY_SYNC_REPO', 'FOGGY_SYNC_BRANCH', 'FOGGY_SYNC_PATH', 'FOGGY_SYNC_TOKEN']) {
  delete process.env[key];
}
// Prevent the server from discovering host credentials through the GitHub CLI/keychain.
process.env.PATH = directory;
const server = await startServer({ loadEnv: false });
const cleanup = async () => {
  await server.close();
  await rm(directory, { recursive: true, force: true });
};
process.once('SIGINT', () => void cleanup());
process.once('SIGTERM', () => void cleanup());
