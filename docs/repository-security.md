# Public Repository Security

Repository files alone do not enforce merge protection. GitHub settings below
must be enabled separately; keep this checklist current as maintainers change.

## Before Changing Visibility

- Confirm the right to publish and license all code, fixtures, and bundled assets.
- Scan the full Git history, all branches and tags, with a dedicated secret scanner
  such as Gitleaks using redacted output. Filename checks are not a secret audit.
  Rotate any exposed credentials before publishing; removing them from the latest
  revision is insufficient. Review non-secret proprietary and personal data too.
- Review issues, PRs, Actions logs and artifacts, releases, and collaborators for
  material or access that should not become public. Keep task-state repositories private.
- Commit and push the safeguard files after review. Confirm the `Checks` job passes
  on GitHub before making it a required check. Local files do not activate CI.
- Require two-factor authentication on maintainer accounts, preferably passkeys or
  security keys. Give collaborators the minimum role needed and review installed
  apps, deploy keys, webhooks, and repository/environment secrets.

## GitHub Settings

In [Actions settings](https://github.com/LLuque-twilio/foggybrain/settings/actions):

- Use read-only default workflow permissions and disable Actions creating or
  approving pull requests.
- Allow only `actions/checkout@*`, `actions/setup-node@*`, and
  `pnpm/action-setup@*`; require full-length SHA pinning. Expand the allowlist only
  after reviewing a new action. Dependabot proposes pinned-action updates.
- Require approval for workflows from **all outside collaborators**, not only
  first-time contributors. Review code and workflow changes before approving a run.
- Use GitHub-hosted runners for untrusted PRs. Never run them on a personal or
  internal self-hosted runner. Keep CI free of application secrets and write tokens.
- Avoid `pull_request_target` and privileged follow-up workflows executing PR code.
  Do not enable automatic merging of dependency or outside-contributor PRs.

In [security settings](https://github.com/LLuque-twilio/foggybrain/settings/security_analysis):

- Enable the dependency graph, Dependabot alerts and security updates.
- Enable secret scanning and push protection; review alerts and any bypasses.
- Enable private vulnerability reporting and verify the link in `SECURITY.md` works.
- Consider CodeQL default setup for JavaScript/TypeScript. If enabling it, review
  the permissions and allowlist needed for GitHub's code-scanning actions.

In [rulesets](https://github.com/LLuque-twilio/foggybrain/settings/rules), create an
**active** branch ruleset targeting the default branch (`master`):

- Restrict deletion and block force pushes.
- Require a pull request, resolved review conversations, and the `Checks` status
  check from the GitHub Actions app. Require the branch to be up to date.
- Require one approval, dismiss stale approvals, and require code-owner review.
- Keep bypass permissions empty unless there is a documented emergency process.

`CODEOWNERS` names the current owner for every file, including workflows and the
ownership file itself. It requests review but does not enforce it without branch
rules. Add a trusted second maintainer as a code owner before enforcing required
code-owner approval for owner-authored PRs: authors cannot approve their own PRs.
Do not grant write access to strangers merely to avoid this restriction.

## Initial Settings Audit

On 2026-09-08 the repository was kept private. Read-only workflow tokens and no
Actions PR approvals were verified. The action allowlist and SHA-pinning
requirement were applied, as were Dependabot alerts and automated security fixes.

The current private plan blocks rulesets and outside-contributor workflow approval
settings. Private vulnerability reporting was unavailable, and GitHub rejected
secret scanning/push protection as unavailable. Enable and verify these immediately
after an authorized visibility change (or a suitable plan upgrade). Public visibility
has not been changed by this setup. Gitleaks 8.30.1 scanned all local Git refs
(five commits) with fully redacted output and found no leaks. This does not cover
remote-only refs, uncommitted files, GitHub artifacts, or proprietary data; repeat
the scan against the final publication history and review those surfaces separately.

These controls reduce risk; they do not establish that submitted code is safe or
turn the local application into an authenticated hosted service.
