# API Maintenance

[openapi.json](../openapi.json) is the checked-in OpenAPI 3.1 HTTP reference, covering all operations, including unscoped and explicit-workspace domain routes. Import the file into an OpenAPI 3.1-compatible viewer or code generator. There is no production OpenAPI endpoint or bundled documentation UI; generation and validation tools are development-only.

## Ownership

- [src/shared.ts](../src/shared.ts) owns shared DTO field shapes. The generator derives component schemas from these TypeScript types and their schema annotations; do not maintain a second handwritten DTO schema catalog.
- [scripts/openapi.ts](../scripts/openapi.ts) owns HTTP route metadata: methods, paths, operation IDs, parameters, body requirements, responses, and descriptions. It also adds focused conditional schema refinements for constraints not captured by DTO field shapes, such as mutually exclusive connection inputs and kind-dependent creation fields.
- [openapi.json](../openapi.json) is the generated, authoritative HTTP reference. Regenerate it; never hand edit it.
- [CONTRACT.md](../CONTRACT.md) owns semantic guarantees, including completion, graph integrity, workspace isolation, destructive operations, and sync reconciliation. [PR verification](pr-verification.md) records detailed readiness precedence and partial-failure behavior.
- Runtime server/domain code still owns validation of requests, stored state, identities, transitions, and whole-graph invariants. The spec is not a runtime validator, and schema conformance does not imply that a state-dependent operation will succeed.

Read the spec, semantic contract, and shared types before changing API consumers or domain behavior. Keep stateful rules in runtime validation rather than encoding a second graph/state validator in the generator or clients.

## Change Workflow

1. Update runtime behavior and shared DTOs together. Put field-shape changes in `src/shared.ts`; update route metadata and focused conditional refinements in `scripts/openapi.ts` when needed.
2. Update semantic guarantees and PR verification documentation if behavior changes. Do not add an endpoint inventory or DTO field catalog back to the contract.
3. Regenerate and review the artifact, including operation IDs, scoped routes, required/null fields, parameters, and status codes:

```sh
pnpm openapi:generate
pnpm openapi:check
```

4. Extend HTTP contract tests for changed operations and request boundaries, then run the repository checks:

```sh
pnpm test
pnpm typecheck
pnpm build
```

`openapi:check` runs the generator with `--check`, verifying artifact freshness and parser validation without rewriting the file. CI checks it alongside `pnpm test`. Commit regenerated `openapi.json` with its source changes, not a manual patch to the artifact.

[src/openapi.test.ts](../src/openapi.test.ts) checks generated artifact equality, OpenAPI parser validity, and the route inventory independently parsed from server registrations. It exercises successful HTTP responses for every operation and validates them against the spec, plus request-boundary cases. These checks detect drift; they do not replace domain tests for completion, cycles, confirmation workflows, or concurrent state changes. Use synthetic fixtures, isolated temporary databases, and mocked GitHub; never perform real GitHub writes for contract tests.
