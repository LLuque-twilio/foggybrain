# Contributing

Use Node.js 22 (at least 22.13.0) and pnpm 10.14.0. Install dependencies with
`pnpm install --frozen-lockfile`; maintain `pnpm-lock.yaml`, not another lockfile.

Read [AGENTS.md](AGENTS.md) for development and safety rules. Before changing API
consumers or domain behavior, read [openapi.json](openapi.json),
[CONTRACT.md](CONTRACT.md), and `src/shared.ts`.
The server owns persistence, validation, IDs, and completion.

Submit focused pull requests and run:

```sh
pnpm test
pnpm typecheck
pnpm build
```

For API changes, run `pnpm openapi:generate`, review the generated `openapi.json`,
and run `pnpm openapi:check` as well. Never hand edit the spec. Shared DTOs own
field shapes; `scripts/openapi.ts` owns route metadata and focused conditional
schema refinements. Runtime validation still owns graph/state rules. See the
[API maintainer guide](docs/api.md) for ownership and contract-test coverage.

For UI changes, also run `pnpm exec playwright install chromium` once and
`pnpm test:e2e`. Format changed files with Prettier. Report checks you could not run.

Use synthetic fixtures and isolated temporary storage. Never run tests against
your working database or perform real GitHub writes in tests. Do not commit
credentials, state exports, or personal task data, including screenshots and logs.
Ignored files can still be force-added; review your staged diff.

Outside-contributor CI may require maintainer approval. Approval to run CI is not
approval to merge. Dependency and workflow updates require review like any other
code. Do not use privileged workflows to execute pull-request code.

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
Keep discussions respectful and focused on the work.

Contributions are licensed under the repository's [MIT license](LICENSE).
