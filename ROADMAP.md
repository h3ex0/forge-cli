# Forge CLI Roadmap

Forge is evolving into a local-first, provider-independent terminal agent that can use cloud APIs or downloaded open-source models without weakening the user's security boundary.

## Shipped in v0.2

- Versioned Zod configuration with v1 migration.
- OS credential-store integration with environment-variable fallback.
- Canonical workspace enforcement and symlink/junction escape checks.
- JSON Schema validation and risk classification for tools.
- Read-only, balanced, and autonomous permission modes.
- Guarded network fetching with DNS-based SSRF defenses.
- Structured process execution and Forge-owned runtime lifecycle tracking.
- Ollama, LM Studio, llama.cpp, and generic OpenAI-compatible runtime adapters.
- Local model discovery, inspection, activation, and explicit downloads where supported.
- Non-interactive and JSON prompt modes plus PowerShell, Bash, Zsh, and Fish completion output.
- Enhanced slash-command REPL, persistent history, pinned context, project instructions, and full-screen streamed chat.
- Git inspection, project detection, approved test/build execution, versioned sessions, and automated tests.

## v0.3 — Reliability and recovery

- Abort active streams and child processes cleanly with Ctrl+C.
- Add bounded provider retries with jitter and useful error classification.
- Add autosave, crash recovery, session export formats, and session deletion.
- Add context-window accounting, compaction, and visible truncation warnings.
- Add per-turn token, cost, time, and tool-iteration budgets.
- Add redacted structured audit records with retention controls.
- Add backup and undo journals for workspace mutations.

## v0.4 — Developer workflow

- Add unified patch application with diff previews.
- Add safe move/delete operations with recoverable behavior.
- Add structured diagnostics and package-manager-aware test runners.
- Add user-reviewed Git staging and commit workflows.
- Add tool result caching and bounded parallel read-only tools.
- Expand machine-readable output across model, session, config, and doctor commands.

## v0.5 — Smart local routing

- Route tasks using health, capabilities, context size, latency, and user policy.
- Prefer capable local models; disclose and approve escalation to cloud providers.
- Add aliases, fallback chains, unload/remove operations, and disk-usage reporting.
- Improve capability detection for Qwen and other model families across runtimes.
- Turn the full-screen UI into a workspace with model, context, tool, diff, and approval panes.

## v0.6 — Extensibility

- Add MCP client support behind the same capability-policy boundary.
- Add versioned plugin manifests with explicit requested capabilities.
- Add reusable prompt packs and project workflow definitions.
- Add multimodal input negotiation for runtimes and providers that support it.
- Document provider, runtime, tool, and plugin authoring APIs.

## v1.0 release gates

- Stable provider, runtime, tool, config, and session compatibility contracts.
- Reproducible packages with provenance, checksums, release notes, and migration guidance.
- Comprehensive cancellation, recovery, audit, and secret-redaction coverage.
- Cross-platform verification on supported Windows, macOS, and Linux versions.
- No unresolved critical or high-severity findings in the supported release.

## Guiding trade-offs

| Decision | Benefit | Trade-off |
| --- | --- | --- |
| Local-first routing | Privacy, offline use, and predictable ownership | Local setup and hardware requirements |
| Capability policy | Least privilege and clearer approvals | More interaction in balanced mode |
| Structured tools | Validation, portability, and reviewability | Less flexibility than arbitrary shell scripts |
| Modular monolith | Simple installation and debugging | Requires disciplined internal interfaces |
| Explicit model pulls | Avoids surprise disk use and license acceptance | Adds a deliberate setup step |

The capability-policy design is recorded in [ADR-0001](docs/adr/0001-capability-based-tool-policy.md). Security details and current limitations are maintained in [SECURITY.md](SECURITY.md).
