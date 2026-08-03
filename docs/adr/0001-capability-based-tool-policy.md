# ADR-0001: Adopt a capability-based tool policy

## Status

Proposed

## Context

Forge currently categorizes tools with a single `destructive` boolean. Mutating tools require confirmation, while read-only tools execute immediately. This is understandable for an alpha, but it cannot express important distinctions such as:

- Reading inside the active workspace versus reading a credential directory
- Running a known test script versus executing an arbitrary shell command
- Fetching a public HTTPS page versus contacting a private-network address
- Allowing an action once versus trusting it for a session or workspace
- Separating file creation, modification, deletion, and process execution

As Forge adds tools and plugins, a binary flag would spread authorization decisions across implementations and make the security model difficult to audit.

## Decision

Introduce a central capability policy engine. Each tool declares granular capabilities and normalized resources. The policy returns one of three decisions:

- `deny` — do not execute
- `ask` — show the resolved action and require explicit confirmation
- `allow` — execute under an existing scoped policy

Initial capability families should include filesystem read/write, process execution, and network access. Policies should be scoped by workspace, session, tool, path/domain, and command where applicable. The tool runtime must authorize resolved resources after canonicalization, not raw model-provided arguments.

The default policy will deny access outside an approved workspace, ask for mutations and process execution, and allow bounded reads inside the workspace. Plugins must declare capabilities before activation and use the same policy path as built-in tools.

## Consequences

### Positive

- Least-privilege behavior can be applied consistently.
- Permission decisions become testable and auditable.
- Users can grant narrow trust without disabling all confirmations.
- Built-in tools, MCP servers, and future plugins share one security boundary.
- Resolved previews make approval prompts more meaningful.

### Negative

- More implementation complexity than a boolean flag.
- Canonical resource handling is platform-specific, especially for Windows junctions and command resolution.
- Conservative defaults may initially produce more prompts.
- Persisted policies require schema versioning and safe migration.

### Neutral

- Tool definitions need new capability metadata.
- The REPL confirmation flow becomes a consumer of policy decisions rather than the policy itself.

## Alternatives considered

### Keep the `destructive` boolean

Simple, but too coarse for path, network, plugin, and session-level decisions. It also treats confidentiality-impacting reads as harmless.

### Ask before every tool call

Safer than automatic execution but creates approval fatigue, which makes users more likely to accept dangerous actions without review.

### Rely only on an operating-system sandbox

Strong isolation is valuable and may be added as defense in depth, but availability and semantics differ across platforms. Forge still needs an application-level policy to explain and constrain intent.

## Implementation notes

1. Define versioned capability and decision types.
2. Normalize and canonicalize resources before evaluating policy.
3. Add deny-by-default rules and protected locations.
4. Render a stable approval preview from the normalized request.
5. Record a redacted decision and outcome in the audit log.
6. Add Windows, macOS, and Linux tests for boundary escapes.
7. Route all built-in and external tools through the same enforcement point.
