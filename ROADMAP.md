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

## Shipped in v0.3 — TUI-first workspace

- TUI is the default for supported interactive terminals. (The inline REPL fallback described here was later removed; a terminal too small or non-interactive for the TUI now gets a direct error pointing at `forge run "<prompt>"` instead.)
- Shared `AgentSession` powers TUI and inline tool execution, permissions, messages, usage, and cancellation.
- Responsive conversation, activity, and context panes.
- Searchable command, model, file-context, and session overlays.
- Multiline composer, scrollback, prompt queue, visible tool activity, and blocking approval dialogs.
- Model/tool terminal-control sanitization and recovery checkpoints before approved high-impact work.
- Prompt, completion, total, and estimated context token status.
- Estimated session cost, cumulative per-profile token ledgers, configured plan ceilings, and provider-reported token/request rate limits.
- Config schema v3, TUI autosave, richer themes, and `NO_COLOR` behavior.

## Shipped in v0.4 — Command power pack

- Workspace navigation commands for ranged reads, context pinning, regex search, glob discovery, and changed-file inspection.
- Package-script-aware lint, format, type-check, test, build, and sequential quality-check workflows.
- Structured `/run` execution with argument arrays and the existing process permission boundary.
- Focused agent workflows for explanation, refactoring, test generation, documentation, security review, and work summaries.
- Autosave resume, conversation branching, Markdown/JSON export, and local usage inspection/reset commands.
- Matching behavior in the inline REPL and full-screen TUI, including palette discovery and visible sequential tool activity.

## Shipped in v0.5 — Mouse workspace and toolbench

- Opt-in/persistent SGR mouse tracking with native terminal text selection as the default.
- Mouse focus for conversation, activity, context, and composer panes with visible focus borders.
- Clickable command, file, model, session, and help actions; clickable overlay rows and approval choices.
- Mouse-wheel scrolling for conversations, activities, and searchable overlays, with keyboard-equivalent pane focus via Tab.
- Workspace metadata, SHA-256, JSON Pointer, workspace-statistics, and Git-show inspection tools.
- Workspace-bounded directory creation and no-overwrite file copying behind write approvals.
- Config schema v5 migration, instant `Ctrl+T`/footer mouse toggling, and shared inline/TUI slash commands for every new tool.
- Borderless focused-pane reader for clean terminal selection and untruncated conversation, activity, composer, and session/error text.

## Since v0.5.2 (unreleased)

- `forge provider list|use|add|remove` and `forge key set`: non-interactive provider/key management outside the TUI, with hidden-input key entry and `FORGE_HOME` to relocate the config directory.
- `spawn_agent` tool and `/agent [profile] <task>`: delegate a self-contained task to a nested subagent (its own context, tool loop, optionally a different provider) that reports back a single result.
- Full-screen frames for the command/model/file/session overlays, the approval prompt, and provider/key entry, replacing the earlier floating boxes that let background chat text bleed through.
- Keyboard- and mouse-navigable approval choice (was Y/N-only with no visible way to select), plus `Ctrl+A`/`[Mode]` to cycle permission mode without needing to already know `/mode`.

## v0.6 — Reliability and recovery

- Add bounded provider retries with jitter and useful error classification.
- Add full filesystem undo journals, richer crash recovery, session export formats, and session deletion.
- Add context-window accounting, compaction, and visible truncation warnings.
- Add per-turn token, cost, time, and tool-iteration budgets.
- Add redacted structured audit records with retention controls.
- Add backup and undo journals for workspace mutations.

## v0.7 — Developer workflow

- Add unified patch application with diff previews.
- Add safe move/delete operations with recoverable behavior.
- Add structured diagnostics and package-manager-aware test runners.
- Add user-reviewed Git staging and commit workflows.
- Add tool result caching and bounded parallel read-only tools.
- Expand machine-readable output across model, session, config, and doctor commands.

## v0.8 — Smart local routing

- Route tasks using health, capabilities, context size, latency, and user policy.
- Prefer capable local models; disclose and approve escalation to cloud providers.
- Add aliases, fallback chains, unload/remove operations, and disk-usage reporting.
- Improve capability detection for Qwen and other model families across runtimes.
- Add dedicated Git diff, diagnostics, plan, and provider-settings panes to the full-screen workspace.

## v0.9 — Extensibility

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
