# Security Policy

Forge is a local AI agent that can read files, modify files, execute commands, and fetch network content. Those capabilities are powerful and should be treated as security-sensitive.

## Supported versions

Forge is currently pre-1.0 alpha software. Security fixes are applied to the latest version on the default branch; older snapshots are not supported.

## Current trust model

- Provider requests are sent directly from your machine to the configured API endpoint.
- Configuration and sessions are stored locally under `~/.forge`.
- `write_file`, `edit_file`, and `bash_exec` require an interactive confirmation.
- Read-only tools currently run without confirmation.
- Tool output is length-limited, and each model turn is capped at ten tool iterations.
- Forge does not currently provide a hardened sandbox.

## Known limitations

Until the security-baseline roadmap is complete:

- Filesystem tools are not restricted to the current workspace.
- Paths may traverse through parent directories, symlinks, or Windows junctions.
- API keys are stored in plaintext in `~/.forge/config.json`.
- `/key` accepts secrets through visible terminal input.
- `bash_exec` executes a shell command string with the user's permissions.
- `web_fetch` does not yet block private/internal addresses or enforce HTTPS.
- Session names and provider configuration require stronger validation.
- There is no centralized secret-redaction pipeline or structured audit log.
- Model responses and remote content may contain prompt-injection instructions.

Run Forge only in directories and under accounts where you can tolerate the consequences of an accidentally approved action. Inspect commands and file changes before approving them.

## Planned defenses

The security work is tracked in [ROADMAP.md](ROADMAP.md) and centers on:

1. Canonical workspace boundaries for every filesystem operation
2. OS keychain-backed secrets and environment-variable references
3. A capability policy with `deny`, `ask`, and `allow` decisions
4. Structured command execution and protected-path rules
5. SSRF defenses, HTTPS defaults, and domain policies
6. Tool-schema validation, secret redaction, and audit logging
7. Diff previews, atomic writes, backups, and safer recovery

## Reporting a vulnerability

Please do not disclose suspected vulnerabilities in a public issue.

Use the repository's **Security → Report a vulnerability** flow to submit a private GitHub Security Advisory. Include:

- The affected version or commit
- Reproduction steps or a proof of concept
- Expected and actual behavior
- Potential impact
- Any suggested mitigation

If private vulnerability reporting is not yet enabled, contact the repository owner privately and request a secure reporting channel before sharing sensitive details.

You should receive an acknowledgement within seven days. Publication and credit will be coordinated after a fix is available.

## Security-sensitive contributions

Changes involving tool execution, filesystem paths, network requests, secrets, configuration, sessions, or plugins should include:

- Abuse cases and trust-boundary notes
- Automated tests for deny and failure paths
- Cross-platform path/process behavior where relevant
- Confirmation that logs and errors do not expose secrets
- Backward-compatibility or migration details
