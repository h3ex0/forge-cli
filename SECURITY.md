# Security Policy

Forge is a local AI agent that can read files, modify files, execute programs, and fetch network content. Treat model responses and fetched content as untrusted input.

## Supported versions

Forge is pre-1.0 software. Security fixes are applied to the latest version on the default branch.

## Current trust model

- Forge runs with the permissions of the current operating-system account; it is not a hardened container or OS sandbox.
- Filesystem tools are restricted to the configured workspace using canonical path resolution and checks against symlink or Windows-junction escapes.
- Glob discovery rejects absolute and parent-traversal patterns; metadata, hashing, JSON queries, statistics, directory creation, and no-overwrite copies reuse the same workspace boundary.
- Tool inputs are validated against JSON Schema before execution.
- `read-only`, `balanced`, and `autonomous` modes decide whether each risk class is allowed, denied, or requires confirmation.
- Structured commands use direct process execution. The compatibility `bash_exec` tool is high-risk and always policy-gated.
- Network fetches accept only HTTP(S), reject URL credentials, resolve DNS, and block loopback, private, link-local, and cloud-metadata-style destinations, including redirects.
- Remote provider keys use the OS credential manager when available, with profile-specific environment variables as a headless fallback.
- File writes are atomic, tool output is capped, and an agent turn is limited to ten tool iterations.
- Model and tool text is stripped of terminal control sequences before the TUI renders it.
- The TUI uses blocking approval overlays and records a recovery session before approved write, process, or shell operations.
- Mouse reports are interpreted only as local navigation input and cannot bypass tool validation or approval policy.
- Active provider streams and structured tool processes receive cancellation signals.
- Offline mode removes network tools and prevents one-shot use of a remote profile.
- Forge only stops local runtime processes that it recorded as Forge-owned.

## Permission modes

| Mode | Read | Write | Process, network, credential, external |
| --- | :---: | :---: | :---: |
| `read-only` | Allow | Deny | Deny |
| `balanced` | Allow | Ask | Ask |
| `autonomous` | Allow | Allow | Ask |

`balanced` is the default. Approvals are capability decisions, not proof that a model-requested action is safe. Inspect the resolved operation and expected effect.

## Known limitations

- Forge does not isolate tools in a VM, container, seccomp profile, or restricted OS account.
- User-approved processes inherit the user's ambient filesystem and network permissions.
- The shell compatibility tool accepts a command string and therefore carries shell parsing and injection risk.
- There is not yet a durable, redacted audit log or automatic backup/undo journal for every mutation.
- Provider retries and context compaction are not yet comprehensive; some third-party child processes may take time to honor cancellation.
- TUI recovery checkpoints preserve conversation state, not filesystem contents; they are not a substitute for Git or backups.
- Third-party local runtimes and downloaded model files have their own supply-chain and license risks.
- `/key` is retained for compatibility but can expose a secret through visible terminal history; prefer the OS credential store or environment variables.
- A model can still be influenced by prompt injection. Policy gates reduce impact but cannot establish the intent or trustworthiness of model output.

Run Forge in a narrowly scoped workspace. Do not approve commands you would not run yourself, and do not place unrelated secrets inside the workspace.

## Reporting a vulnerability

Do not disclose suspected vulnerabilities in a public issue. Use GitHub's **Security → Report a vulnerability** flow for this repository and include:

- affected version or commit;
- reproduction steps or a proof of concept;
- expected and actual behavior;
- likely impact; and
- suggested mitigation, if known.

If private vulnerability reporting is unavailable, contact the repository owner privately and request a secure channel before sending sensitive details. An acknowledgement is targeted within seven days.

## Security-sensitive contributions

Changes involving paths, processes, network requests, credentials, sessions, runtimes, or plugins should include abuse cases, deny-path tests, cross-platform considerations, secret-exposure checks, and migration notes where applicable.
