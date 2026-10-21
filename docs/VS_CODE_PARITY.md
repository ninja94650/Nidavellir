# Nidavellir: VS Code parity and AI collaboration roadmap

Nidavellir is an independent Electron coding environment. This document tracks the work needed to make it a capable, extensible development studio. It is **not** a claim that Nidavellir already implements every Visual Studio Code feature.

## Current foundation (v0.2.0)

- Electron desktop shell with a Monaco editor and dark theme.
- File and folder open/save workflows and a basic project explorer.
- AI requests to OpenAI, Google Gemini, and Anthropic Claude when the user supplies provider API keys.
- A coordinator that can synthesize configured providers' answers.
- Manifest-based local plugins, lifecycle hooks, and example plugins.
- A guarded project runner, run history, AI-generated tests, and review-before-apply diff UI.
- Context-isolated preload bridge and encrypted API-key storage where Electron safeStorage is available.

## Feature roadmap

### P0 — Security and reliability
- [ ] Validate every IPC payload and constrain file operations to user-selected workspaces where applicable.
- [ ] Add path traversal tests, file-size limits, cancellation, and error reporting.
- [ ] Treat plugin code and project code as untrusted; document that a Node/Electron plugin is not a security sandbox.
- [ ] Keep API keys out of renderer state, logs, source control, and AI prompts.
- [ ] Add automated dependency, lint, unit, and packaging checks in CI.
- [ ] Require explicit user review before applying generated edits or running commands with side effects.

### P1 — Daily editor workflow
- [ ] Multi-tab editing, dirty-state indicators, close/reopen, and session restore.
- [ ] Workspace-wide file search, replace, and fuzzy quick-open.
- [ ] Undo/redo, configurable keybindings, command palette, and keyboard shortcuts.
- [ ] Editor settings: font, font size, word wrap, minimap, line numbers, themes, and autosave.
- [ ] Breadcrumbs, outline/symbol navigation, go-to-definition, references, rename, and diagnostics via language servers.
- [ ] Integrated terminal with explicit shell selection, working directory, process cancellation, and visible command history.
- [ ] Git status, diff, staging, commit, branches, and conflict resolution.
- [ ] Debug adapter protocol integration, breakpoints, variables, and call stack.
- [ ] Tasks, launch configurations, snippets, formatters, linters, and test explorer.
- [ ] Accessibility: keyboard-only flows, screen-reader labels, contrast, and zoom.

### P2 — Extensibility
- [ ] Versioned extension manifest and API, compatibility checks, activation events, and dependency declarations.
- [ ] Extension discovery/install/update/disable UI with provenance and permission prompts.
- [ ] Extension host isolation and resource limits before third-party extensions are enabled by default.
- [ ] Language-server and debug-adapter adapters instead of bespoke language support.
- [ ] Workspace trust mode and clear permissions for filesystem, network, terminal, and secrets.

### P3 — Multi-agent AI workspace
- [ ] Provider registry with model discovery, per-provider status, configurable timeout/retry, and cancellation.
- [ ] Parallel requests to all enabled/configured providers; show each answer and errors independently.
- [ ] Coordinator synthesizes answers, flags disagreements, cites which provider suggested each change, and never hides raw answers.
- [ ] Shared project context assembled from user-selected files and bounded workspace search; respect ignore files and secret exclusions.
- [ ] Task plans, agent roles (planner, implementer, reviewer, tester), and shared task state.
- [ ] Proposed edits represented as patches; show a reviewable diff before writing files.
- [ ] Test generation and execution in a restricted process, with user confirmation for network access or destructive operations.
- [ ] Provider adapters for additional services only when their APIs, authentication, licensing, and terms permit it.

## AI provider and plugin access model

"All AI plugins" cannot mean unrestricted access to every commercial model or service. Each service may require its own API key, account, subscription, billing, and explicit authorization. Nidavellir should only call providers the user configures and enables. Do not scrape private services or bypass access controls.

Plugins should receive only documented capabilities. Do not give every plugin unrestricted filesystem, shell, network, or credential access. Use least-privilege permissions, clear consent, and an auditable activity log. Treat project files and model output as untrusted input.

## Definition of done

A feature is complete only when its UI, main-process implementation, error paths, tests, security review, and documentation exist. A checklist item is not implemented merely because it appears in this roadmap. VS Code is a mature product with a broad extension ecosystem; parity is an incremental goal, not a one-commit change.
