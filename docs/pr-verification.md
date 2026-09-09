# PR Verification

See [CONTRACT.md](../CONTRACT.md#pr-verification) for completion and verification guarantees, [openapi.json](../openapi.json) for HTTP schemas, and [src/shared.ts](../src/shared.ts) for DTOs. `prMergeStatus` describes informational GitHub gate readiness, not task completion or permission for a particular user to merge. Only REST-verified `prState: "merged"` satisfies a PR gate.

## Readiness Precedence

For REST-open, unmerged PRs, the poller fetches GraphQL `state`, `isDraft`, `reviewDecision`, `mergeStateStatus`, and `commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`. Valid metadata maps in this order; first match wins:

1. `unknown`: GraphQL says closed/merged; REST remains authoritative until the next poll.
2. `draft`: `isDraft` or merge state `DRAFT`.
3. `conflicts`: merge state `DIRTY`.
4. `changes_requested`: review decision `CHANGES_REQUESTED`.
5. `checks_failing`: rollup `ERROR`/`FAILURE` or merge state `UNSTABLE`, including non-required failing checks.
6. `checks_pending`: rollup `EXPECTED`/`PENDING`.
7. `under_review`: review decision `REVIEW_REQUIRED`.
8. `blocked`: merge state `BLOCKED`, `BEHIND`, or `HAS_HOOKS`, without a more specific gate above.
9. `ready`: merge state `CLEAN` with none of the preceding gates; review is `APPROVED` or null, and rollup is `SUCCESS` or null (no checks). Merely open/mergeable is never sufficient.
10. `unknown`: otherwise (merge state `UNKNOWN`).

REST-closed/merged PRs need no GraphQL request and reset readiness to `unknown`.

## Failures And Persistence

Malformed/incomplete metadata, GraphQL errors even with partial data, transport failures, and permission errors retain previous readiness and set a sanitized `prError` explicitly marking readiness unavailable/potentially stale. Independently successful REST state still persists. REST failures retain both verified fields. Successful polling clears `prError`; `prCheckedAt` records the latest attempt, not necessarily the last successful metadata verification. Consumers must treat a non-null error as stale/incomplete verification. No raw upstream errors or tokens are exposed.

Verification updates apply each supplied verified field independently even when an error is present; callers omit fields whose verification failed, and omitted fields are retained. Pollers must not apply a response after the task's PR URL changes or is removed. Task creation/update APIs cannot set verification fields.

New tasks, including non-PR tasks, and legacy SQLite snapshots missing readiness default to `unknown`. Verification is local persistent state, excluded from portable exports. Imports retain readiness, verification, and errors only for the same ID, kind, and URL. PR URL changes/removal or newly imported identities reset verification without changing manual work status. Manual PR gates are polled exactly like standalone PR tasks.
