# Security Policy

## Reporting a Vulnerability

Do not report vulnerabilities in public issues or pull requests. Use GitHub's
[private vulnerability reporting](https://github.com/LLuque-twilio/foggybrain/security/advisories/new)
when enabled. If that option is unavailable, ask the maintainer for a private
reporting channel without disclosing vulnerability details publicly.

Include affected revisions, reproduction steps using synthetic data, impact, and
any suggested mitigation. Never include live tokens, personal task graphs,
SQLite databases, or sensitive logs and screenshots. Rotate exposed credentials
immediately; deleting a file or comment does not revoke a credential.

Security fixes target the latest default-branch revision. Older revisions have no
guaranteed backports. This project does not promise a response-time SLA.

## Security Boundary

FoggyBrain is a trusted local tool, not an authenticated multi-user service. Do not
expose its API publicly. Loopback binding is not authorization. Cloud workspaces
remain local-first and their state repositories must be private. Making this
source repository public does not make task data safe to publish.

Keep credentials server-side and least-privilege. Never give public CI access to
personal GitHub tokens, sync credentials, or working databases. See the
[local usage guide](docs/local-guide.md#security-limits) and [agent guidance](AGENTS.md) for
operational constraints.
