# Changelog

All notable changes to Verenne Code are documented here. The project follows semantic versioning.

## 1.0.1 — 2026-07-23

- Make zero-command startup work outside Git repositories by prompting for a project folder.
- Accept quoted and drag-and-dropped repository paths, retry invalid selections, and keep startup non-destructive.
- Give non-interactive and invalid `--repo` runs concise, actionable guidance instead of a raw Git error.
- Promote new versions to GitHub Releases only after the full cross-platform CI workflow succeeds.

## 1.0.0 — 2026-07-23

- First production release of Arena, Swarm, Relay, and current-patch verification.
- Native adapters for Claude Code, OpenAI Codex, OpenCode, Gemini CLI, Aider, and custom agents.
- Fail-closed Intent Contracts that link required outcomes to observed paths, base-owned gates, and specifically proven claim IDs.
- Clean candidate replay plus base-restored replay when tests, runners, manifests, lockfiles, or other verification inputs change.
- Credentialless candidate bootstrap, isolated gate homes, sealed patch application, and share-safe case files.
- One Windows batch-command launch boundary shared by gates, adapters, and bootstrap commands, with bounded output and process-tree cancellation.
- Terminal-first command center with accessible Arena, diff, intent, and evidence views.
- GitHub Action, MCP server, local memory, provider-native model/effort forwarding, process-tree cancellation with persisted mission state, and zero-dependency runtime.
